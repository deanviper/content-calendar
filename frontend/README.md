# Content calendar front end

A monthly calendar of scheduled and suggested posts for X and LinkedIn. Days with content carry a
marker per post; clicking a day lists its posts with the copy, hashtags, assets and a character
count against each platform's limit, plus a button to copy the text.

No build step. Serve the folder and open it:

```sh
cd frontend
python3 -m http.server 8000
# http://localhost:8000
```

## Files

- `index.html` – page shell
- `src/styles.css` – all styling; brand colours and the typeface are tokens at the top of the file
- `src/data.js` – the post shape, the loader and sample posts
- `src/app.js` – calendar rendering and interaction
- `assets/` – the mark and sample post graphics

## Connecting real data

`src/data.js` documents the post shape. Set `API_URL` to an endpoint that returns an array of posts in
that shape and the sample data is no longer used. Times are shown in Manila time (`TIME_ZONE`), and a
post lands on the day of its `scheduledAt` in that zone.

## Branding

Colours, type and the mark are placeholders in Silencio's minimal black and white style until the
official brand files are added. To apply them, replace the tokens at the top of `src/styles.css` and
`assets/mark.svg`.

## Keyboard

Arrow keys move between days, Page Up and Page Down change month. The selected day is kept in the URL
hash, so `#2026-10-28` links straight to that day.
