# Zoey's photos

Drop images here (`.jpg`, `.png`, `.webp`, `.gif`), then from the repo root:

```
python scripts/build_zoey.py
```

and commit both the photos and the regenerated `data/zoey.json`.
`zoey.html` reads that manifest — photos don't appear until it's rebuilt.

- **Albums**: a subdirectory becomes an album — `puppy-days/` shows as
  "Puppy Days". Files directly in this folder go in a plain "Photos" album.
- **Captions**: a filename like `zoey_first_snow.jpg` becomes the caption
  "Zoey first snow"; camera names (`IMG_1234.jpg`) get none. To caption
  those, add a `captions.txt` next to them with lines like
  `IMG_1234.jpg: Mud. So much mud.`
- **Dates**: taken from JPEG EXIF automatically; each album shows newest
  first.
- **Sizing**: export around 2000 px on the long edge (~300–800 KB). The
  builder warns above ~1.2 MB — hundreds of full-resolution originals make
  the repo and the page slow.
- **iPhone**: export as JPEG, not HEIC — browsers can't display HEIC and
  the builder skips it.
