# The Nadda Daily
Static site: index.html, style.css, app.js, content/YYYY-MM-DD.json (+ latest.json fallback). `?date=YYYY-MM-DD` loads a past issue.
Daily: write inputs/DATE.json with real sourced news (see generate.py docstring) -> `python3 generate.py` -> deploy folder.
Local: `python3 -m http.server 8811` ; screenshots: `python3 shoot.py`.
