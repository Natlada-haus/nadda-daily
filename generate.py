#!/usr/bin/env python3
"""Build content/YYYY-MM-DD.json for The Nadda Daily.

Daily routine:
 1. An agent (or you) researches REAL news with web search and writes
    inputs/YYYY-MM-DD.json (same shape as inputs/2026-10-13.json):
    thailand[], world[] (each with title, th, en, source, url),
    social[] ('Social Pulse': 4-6 real items from the last few days on
    platform changes, Thai/global social trends, viral formats, brand
    campaigns; each with title, th, why ('why it matters for me'), source, url), lifestyle,
    word, english, know, on_this_day, three_things, wordsearch_words.
    Never invent news; every brief needs a source + url.
 2. Run:  python3 generate.py [YYYY-MM-DD]   (default: today, Asia/Bangkok)
    This adds live Bangkok weather (open-meteo, no key), a seeded word-search
    grid and a 6x6 mini sudoku, then writes content/DATE.json and
    content/latest.json (fallback when today's file is missing).
"""
import json, random, sys, datetime, urllib.request, pathlib
from zoneinfo import ZoneInfo
ROOT = pathlib.Path(__file__).parent
date = sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.now(ZoneInfo("Asia/Bangkok")).date().isoformat()
data = json.loads((ROOT / f"inputs/{date}.json").read_text())
rng = random.Random(date)

WMO = {0:"Clear",1:"Mostly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Fog",51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",61:"Light rain",63:"Rain",65:"Heavy rain",80:"Showers",81:"Showers",82:"Violent showers",95:"Thunderstorms",96:"Thunderstorms, hail",99:"Thunderstorms, hail"}
def weather():
    u = ("https://api.open-meteo.com/v1/forecast?latitude=13.75&longitude=100.50"
         "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,uv_index_max"
         f"&current=temperature_2m,relative_humidity_2m&timezone=Asia/Bangkok&start_date={date}&end_date={date}")
    try:
        j = json.load(urllib.request.urlopen(u, timeout=20)); d = j["daily"]
        return {"max": round(d["temperature_2m_max"][0]), "min": round(d["temperature_2m_min"][0]),
                "rain": d["precipitation_probability_max"][0], "uv": round(d["uv_index_max"][0]),
                "cond": WMO.get(d["weather_code"][0], "—"), "humidity": j["current"]["relative_humidity_2m"],
                "source": "Open-Meteo", "fetched": datetime.datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%H:%M")}
    except Exception as e:
        return {"error": str(e)}

def wordsearch(words, n=10):
    g = [[None]*n for _ in range(n)]; placed = []
    dirs = [(0,1),(1,0),(1,1),(-1,1)]
    for w in sorted(words, key=len, reverse=True):
        for _ in range(500):
            dr, dc = rng.choice(dirs); r, c = rng.randrange(n), rng.randrange(n)
            cells = [(r+dr*i, c+dc*i) for i in range(len(w))]
            if all(0<=a<n and 0<=b<n and g[a][b] in (None, w[i]) for i,(a,b) in enumerate(cells)):
                for i,(a,b) in enumerate(cells): g[a][b] = w[i]
                placed.append({"word": w, "cells": cells}); break
    abc = "ABCDEFGHIJKLMNOPRSTUVWY"
    return {"grid": ["".join(ch or rng.choice(abc) for ch in row) for row in g], "words": placed}

def sudoku6():
    base = [[(r*3 + r//2 + c) % 6 + 1 for c in range(6)] for r in range(6)]  # valid 6x6 (2x3 boxes)
    perm = list(range(1,7)); rng.shuffle(perm)
    sol = [[perm[v-1] for v in row] for row in base]
    bands = [0,1,2]; rng.shuffle(bands)
    rows = [b*2+i for b in bands for i in rng.sample([0,1],2)]
    sol = [sol[r] for r in rows]
    puz = [[v if rng.random() < 0.45 else 0 for v in row] for row in sol]
    return {"puzzle": puz, "solution": sol}

data.update(date=date, weather=weather(), wordsearch=wordsearch(data.pop("wordsearch_words")), sudoku=sudoku6())
out = json.dumps(data, ensure_ascii=False, indent=1)
(ROOT / f"content/{date}.json").write_text(out); (ROOT / "content/latest.json").write_text(out)
print("wrote content/%s.json" % date)
