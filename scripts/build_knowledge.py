#!/usr/bin/env python3
"""Build the aviation knowledge map data from Markdown sources.

Source of truth: data/knowledge/*.md — one file per top-level domain, plus
_root.md for the map's root node. Nesting (2 spaces per level) is
containment; a trailing `-> target "label"` on a line is a cross-link to
another node's id. Explicit ids are written `{#slug}`; nodes without one get
an auto-generated id (they're never referenced as a link target).

Output: data/knowledge.json — consumed directly by js/knowledge.js.

Stdlib only, no dependencies. Run from the repo root:  python scripts/build_knowledge.py
Validates as it goes: duplicate ids and unresolved link targets are fatal.
"""
import json
import os
import re
import sys
import unicodedata

SRC_DIR = os.path.join("data", "knowledge")
OUT = os.path.join("data", "knowledge.json")

FM_RE = re.compile(r"^---\s*$")
BULLET_RE = re.compile(r"^(?P<indent>[ ]*)-[ ]+(?P<rest>.*)$")
ID_RE = re.compile(r"\s*\{#([\w-]+)\}\s*$")
LINK_RE = re.compile(r'->\s+([\w-]+)\s+"([^"]*)"')


def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.replace("&", " and ").lower()
    s = re.sub(r"[^\w\s-]", "", s).strip()
    s = re.sub(r"[\s_]+", "-", s)
    return re.sub(r"-+", "-", s) or "node"


class Builder:
    def __init__(self):
        self.nodes = {}          # id -> node dict
        self.order = []          # node ids in document order
        self.groups = {}         # key -> {name, color}
        self.used_ids = set()
        self.root_id = None
        self.pending_links = []  # (source_id, target_slug, label)
        self.errors = []

    # ---- id helpers -----------------------------------------------------
    def claim(self, explicit, label):
        """Return a unique id: the explicit one (must be unique) or an auto slug."""
        if explicit:
            if explicit in self.used_ids:
                self.errors.append("duplicate id: #%s" % explicit)
            self.used_ids.add(explicit)
            return explicit
        base = slugify(label)
        cand = base
        i = 2
        while cand in self.used_ids:
            cand = "%s-%d" % (base, i)
            i += 1
        self.used_ids.add(cand)
        return cand

    def add(self, nid, label, group, summary, parent):
        self.nodes[nid] = {"id": nid, "label": label, "group": group,
                           "summary": summary, "parent": parent, "children": []}
        self.order.append(nid)
        if parent is not None:
            self.nodes[parent]["children"].append(nid)

    # ---- parsing --------------------------------------------------------
    @staticmethod
    def parse_frontmatter(lines):
        fm, body_start = {}, 0
        if lines and FM_RE.match(lines[0]):
            for i in range(1, len(lines)):
                if FM_RE.match(lines[i]):
                    body_start = i + 1
                    break
                if ":" in lines[i]:
                    k, _, v = lines[i].partition(":")
                    fm[k.strip()] = v.strip()
        return fm, lines[body_start:]

    def split_rest(self, rest):
        """rest -> (label, explicit_id, summary, [(target,label),...])."""
        label_part, _, after = rest.partition(" :: ")
        explicit = None
        m = ID_RE.search(label_part)
        if m:
            explicit = m.group(1)
            label_part = label_part[:m.start()]
        links = LINK_RE.findall(after)
        summary = LINK_RE.sub("", after).strip()
        return label_part.strip(), explicit, summary, links

    def parse_domain(self, fm, body, is_root):
        group = fm["group"]
        self.groups[group] = {"name": fm.get("groupName", fm.get("label", group)),
                              "color": fm.get("color", "#888888")}
        summary_lines, bullets_start = [], len(body)
        for i, ln in enumerate(body):
            if BULLET_RE.match(ln):
                bullets_start = i
                break
            if ln.strip():
                summary_lines.append(ln.strip())
        dom_id = self.claim(fm["id"], fm.get("label", "domain"))
        parent = None if is_root else self.root_id
        self.add(dom_id, fm.get("label", "Aviation"), group, " ".join(summary_lines), parent)
        if is_root:
            self.root_id = dom_id
        # walk the bullet list, tracking indentation -> depth
        stack = [(-1, dom_id)]  # (depth, id)
        for ln in body[bullets_start:]:
            m = BULLET_RE.match(ln)
            if not m:
                continue
            depth = len(m.group("indent")) // 2
            label, explicit, summary, links = self.split_rest(m.group("rest"))
            while stack and stack[-1][0] >= depth:
                stack.pop()
            parent_id = stack[-1][1]
            nid = self.claim(explicit, label)
            self.add(nid, label, group, summary, parent_id)
            for tgt, lbl in links:
                self.pending_links.append((nid, tgt, lbl))
            stack.append((depth, nid))
        return dom_id, int(fm.get("order", 9999))

    def build(self):
        files = sorted(f for f in os.listdir(SRC_DIR)
                       if f.endswith(".md") and f != "README.md")
        root_file = [f for f in files if f == "_root.md"]
        if not root_file:
            self.errors.append("missing data/knowledge/_root.md")
            return self.finish()
        domains = []
        # root first so root_id exists when domains attach to it
        for fname in root_file + [f for f in files if f != "_root.md"]:
            with open(os.path.join(SRC_DIR, fname), encoding="utf-8") as fh:
                lines = fh.read().split("\n")
            fm, body = self.parse_frontmatter(lines)
            if "group" not in fm or "id" not in fm:
                self.errors.append("%s: frontmatter needs id and group" % fname)
                continue
            dom_id, order = self.parse_domain(fm, body, is_root=(fname == "_root.md"))
            if fname != "_root.md":
                domains.append((order, dom_id))
        # order the root's children by frontmatter `order`
        domains.sort()
        self.nodes[self.root_id]["children"] = [d for _, d in domains]
        # order groups to match the domain sequence (root first) so the legend
        # renders in the intended order rather than file-read (alphabetical) order
        ordered = {}
        root_group = self.nodes[self.root_id]["group"]
        ordered[root_group] = self.groups[root_group]
        for _, dom_id in domains:
            g = self.nodes[dom_id]["group"]
            ordered[g] = self.groups[g]
        self.groups = ordered
        # resolve cross-links
        cross, seen = [], set()
        for src, tgt, lbl in self.pending_links:
            if tgt not in self.nodes:
                self.errors.append("unresolved link target: %s -> %s" %
                                   (self.nodes[src]["label"], tgt))
                continue
            key = tuple(sorted((src, tgt)))
            if key in seen:
                continue
            seen.add(key)
            cross.append({"a": src, "b": tgt, "label": lbl})
        return self.finish(cross)

    def finish(self, cross=None):
        if self.errors:
            for e in self.errors:
                sys.stderr.write("ERROR: %s\n" % e)
            sys.exit(1)
        nodes = [self.nodes[i] for i in self.order]
        return {"groups": self.groups, "root": self.root_id,
                "nodes": nodes, "cross": cross or []}


def main():
    if not os.path.isdir(SRC_DIR):
        sys.stderr.write("no %s directory\n" % SRC_DIR)
        sys.exit(1)
    data = Builder().build()
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print("built %s: %d nodes, %d cross-links, %d groups" %
          (OUT, len(data["nodes"]), len(data["cross"]), len(data["groups"])))


if __name__ == "__main__":
    main()
