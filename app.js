const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const today = new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Bangkok'});
const qd = new URLSearchParams(location.search).get('date');

async function load(){
  for (const f of [qd || today, 'latest']) {
    try { const r = await fetch(`content/${f}.json`, {cache:'no-cache'}); if (r.ok) return r.json(); } catch(e){}
  }
  throw new Error('no content');
}
const brief = b => `<div class="brief ${b.lead?'lead':''}"><h3>${esc(b.title)}</h3><p lang="th">${esc(b.th)}</p><p class="en">${esc(b.en)}</p><p class="src">— <a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.source)}</a></p></div>`;

load().then(d => {
  const dt = new Date(d.date+'T00:00:00+07:00');
  const long = dt.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'});
  const thd = dt.toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'});
  const w = d.weather, e = d.english, K = 'nd:'+d.date;
  document.title = `The Nadda Daily — ${long}`;
  document.getElementById('paper').innerHTML = `
  <div class="topline"><span>Vol. I · No. ${d.issue_no||1}</span><span>Printed for one · Bangkok</span></div>
  <header class="mast"><h1>The Nadda Daily</h1><div class="tag">${esc(d.tagline||'')}</div></header>
  <div class="dateline"><span>${long}</span><span lang="th">${thd}</span><span>Bangkok ${w.max??'–'}° / ${w.min??'–'}°</span></div>
  <div class="grid">
   <div class="col">
    <section><h2>Thailand Today <small>ข่าวไทย</small></h2>${d.thailand.map(brief).join('')}</section>
    <section><h2>Lifestyle <small>${esc(d.lifestyle.note||'')}</small></h2><h3>${esc(d.lifestyle.title)}</h3><p lang="th">${esc(d.lifestyle.body)}</p></section>
   </div>
   <div class="col">
    <section><h2>The World in Brief <small>ต่างประเทศ</small></h2>${d.world.map(brief).join('')}</section>
    <section class="english"><h2>English, Gently <small>ภาษาอังกฤษ</small></h2><h3>${esc(e.title)}</h3>
     <div class="dialog">${e.dialogue.map(([s,t])=>`<p><b>${esc(s)}:</b> ${esc(t)}</p>`).join('')}</div>
     <ul class="vocab">${e.vocab.map(([en,th])=>`<li>${esc(en)}<span class="th">${esc(th)}</span></li>`).join('')}</ul>
     <div class="tip"><b>Say it better.</b> <s>${esc(e.tip.instead)}</s> → <i>${esc(e.tip.better)}</i><br><span class="th">${esc(e.tip.why)}</span></div></section>
    <section><h2>Know This</h2>${d.know.map(k=>`<p><b>${esc(k.title)}.</b> ${esc(k.body)}</p>`).join('')}</section>
   </div>
   <div class="col">
    <section class="word"><h2>Word of the Day</h2><div class="w">${esc(d.word.word)}</div><div class="meta">${esc(d.word.pos)} ${esc(d.word.ipa)} · <span class="th">${esc(d.word.th)}</span></div><p>${esc(d.word.def)} <i>“${esc(d.word.ex)}”</i></p></section>
    <section><h2>Word Search <small>tap first & last letter</small></h2><div class="ws" id="ws"></div><div class="words" id="wl"></div></section>
    <section><h2>Mini Sudoku <small>1–6 · each row, column, box</small></h2><div class="sd" id="sd"></div><div class="center"><button class="btn" id="chk">Check</button><button class="btn" id="clr">Clear</button></div></section>
    <section class="weather"><h2>Bangkok Weather <small>${esc(w.source||'')} ${w.fetched?'· '+w.fetched:''}</small></h2>
     ${w.error?'<p>Weather unavailable.</p>':`<span class="big">${w.max}°</span> <span>low ${w.min}° · ${esc(w.cond)}</span><p>Rain chance ${w.rain}% · UV ${w.uv} · Humidity ${w.humidity}%</p>`}</section>
    <section class="otd"><h2>On This Day</h2>${d.on_this_day.map(o=>`<p><b>${esc(o.year)}</b>${esc(o.text)}</p>`).join('')}</section>
    <section><h2>Three Things Today</h2><ul class="check">${d.three_things.map((t,i)=>`<li><label><input type="checkbox" data-i="${i}"><span>${esc(t)}</span></label></li>`).join('')}</ul></section>
    <section class="answers" id="ans"><h2>Answers <small>upside down</small></h2><div class="flip">
     <div>${d.wordsearch.words.map(x=>x.word).join(' · ')}</div>
     ${d.sudoku.solution.map(r=>`<pre>${r.join(' ')}</pre>`).join('')}</div>
     <div class="center"><button class="btn" id="rev">Reveal</button></div></section>
   </div>
  </div>
  <footer>The Nadda Daily · compiled each morning · sources linked in each brief</footer>`;

  // checklist
  const ck = JSON.parse(localStorage.getItem(K+':todo')||'{}');
  document.querySelectorAll('.check input').forEach(c=>{ c.checked=!!ck[c.dataset.i]; c.onchange=()=>{ck[c.dataset.i]=c.checked;localStorage.setItem(K+':todo',JSON.stringify(ck));}; });

  // word search
  const ws = document.getElementById('ws'), wl = document.getElementById('wl'), G = d.wordsearch.grid;
  const found = new Set(JSON.parse(localStorage.getItem(K+':ws')||'[]'));
  G.forEach((row,r)=>[...row].forEach((ch,c)=>{ const s=document.createElement('span'); s.textContent=ch; s.dataset.k=r+','+c; ws.append(s); }));
  wl.innerHTML = d.wordsearch.words.map(x=>`<span data-w="${x.word}">${x.word}</span>`).join('');
  const cell = k => ws.querySelector(`[data-k="${k}"]`);
  const paint = () => d.wordsearch.words.forEach(x=>{ if(found.has(x.word)){ x.cells.forEach(([a,b])=>cell(a+','+b).classList.add('found')); wl.querySelector(`[data-w="${x.word}"]`).classList.add('done'); }});
  paint(); let first=null;
  ws.onclick = ev => { const s = ev.target.closest('span'); if(!s) return;
    if(!first){ first=s; s.classList.add('sel'); return; }
    const a=first.dataset.k, b=s.dataset.k; first.classList.remove('sel'); first=null;
    for(const x of d.wordsearch.words){ const ks=x.cells.map(c=>c.join(',')); const s0=ks[0], s1=ks[ks.length-1];
      if((a===s0&&b===s1)||(a===s1&&b===s0)){ found.add(x.word); localStorage.setItem(K+':ws',JSON.stringify([...found])); paint(); } } };

  // sudoku
  const sd = document.getElementById('sd'), P=d.sudoku.puzzle, S=d.sudoku.solution;
  const sv = JSON.parse(localStorage.getItem(K+':sd')||'{}');
  P.flat().forEach((v,i)=>{ const inp=document.createElement('input'); inp.inputMode='numeric'; inp.maxLength=1; inp.setAttribute('aria-label','cell '+(i+1));
    if(v){inp.value=v;inp.readOnly=true;} else { inp.value=sv[i]||''; inp.oninput=()=>{ inp.value=inp.value.replace(/[^1-6]/g,''); inp.classList.remove('bad'); sv[i]=inp.value; localStorage.setItem(K+':sd',JSON.stringify(sv)); }; }
    sd.append(inp); });
  document.getElementById('chk').onclick=()=>{ let ok=true; [...sd.children].forEach((inp,i)=>{ const want=S.flat()[i]; if(inp.value && +inp.value!==want){inp.classList.add('bad');ok=false;} if(!inp.value) ok=false; }); sd.classList.toggle('win',ok); };
  document.getElementById('clr').onclick=()=>{ [...sd.children].forEach((inp,i)=>{ if(!inp.readOnly){inp.value='';delete sv[i];} }); localStorage.setItem(K+':sd','{}'); sd.classList.remove('win'); };
  document.getElementById('rev').onclick=e=>{ const a=document.getElementById('ans'); a.classList.toggle('show'); e.target.textContent=a.classList.contains('show')?'Hide':'Reveal'; };
}).catch(()=>{ document.getElementById('paper').innerHTML='<p class="loading">No edition found for today.</p>'; });
