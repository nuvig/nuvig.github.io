"""Fetch ASRS Database Online records matching a full-text query, stdlib only.

Replays the ASRS DBOnline (akama.arc.nasa.gov/ASRSDBOnline) ASP.NET query wizard:
  1. new session -> QueryWizard_Filter.aspx
  2. add a "Text contains" search item (__EVENTTARGET=-24)
  3. fill the text popup (narrative + synopsis)
  4. run the search
  5. download the CSV export

Usage: python fetch_asrs.py "SFRA OR ADIZ OR FRZ" out.csv
"""
import http.cookiejar
import re
import sys
import urllib.parse
import urllib.request

BASE = "https://akama.arc.nasa.gov/ASRSDBOnline/"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"


def make_opener():
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [("User-Agent", UA)]
    return op


def get(op, url):
    with op.open(BASE + url, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def post(op, url, fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(BASE + url, data=data)
    with op.open(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace"), r.geturl()


def hidden_fields(html):
    from html.parser import HTMLParser
    import html as htmlmod

    out = {}

    class P(HTMLParser):
        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if tag == "input" and a.get("type") == "hidden" and a.get("name"):
                out[a["name"]] = htmlmod.unescape(a.get("value") or "")

    P().feed(html)
    return out


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else "SFRA OR ADIZ OR FRZ"
    outpath = sys.argv[2] if len(sys.argv) > 2 else "asrs_export.csv"
    op = make_opener()

    # 1. start a session on the filter page
    html = get(op, "QueryWizard_Filter.aspx")

    # 2. add the "Text contains" search item
    f = hidden_fields(html)
    f["18.x"] = "1"  # the + image button for "Text contains [words]" (category 18)
    f["18.y"] = "1"
    html, _ = post(op, "QueryWizard_Filter.aspx", f)
    m = re.search(r"QueryWizard_Textpopup\.aspx\?statementId=(\d+)", html)
    if not m:
        sys.exit("could not add Text search item (no statementId in response)")
    sid = m.group(1)

    # 3. fill in the text popup
    popup_url = f"QueryWizard_Textpopup.aspx?statementId={sid}&statementType=Filter"
    phtml = get(op, popup_url)
    pf = hidden_fields(phtml)
    if 'name="SearchString"' not in phtml:
        sys.exit("popup layout changed: no SearchString textarea")
    pf["SearchString"] = query
    pf["NarrativeCheckBox"] = "on"
    pf["SynopsisCheckBox"] = "on"
    pf["SaveButton.x"] = "1"
    pf["SaveButton.y"] = "1"
    post(op, popup_url, pf)

    # 4. run the search
    html = get(op, "QueryWizard_Filter.aspx")
    if query.split()[0].lower() not in html.lower():
        sys.exit("text item did not persist; aborting")
    f = hidden_fields(html)
    f["_ctl6.x"] = "1"
    f["_ctl6.y"] = "1"
    rhtml, rurl = post(op, "QueryWizard_Filter.aspx", f)
    m = re.search(r"returned\s+([\d,]+)\s+ACNs", rhtml)
    count = m.group(1) if m else "?"
    print(f"search returned {count} ACNs ({rurl})")

    # 5. download the CSV export
    with op.open(BASE + "QueryWizard_ExportExcel.aspx?ExportType=CSV", timeout=300) as r:
        body = r.read()
    with open(outpath, "wb") as fh:
        fh.write(body)
    print(f"wrote {len(body)} bytes to {outpath}")


if __name__ == "__main__":
    main()
