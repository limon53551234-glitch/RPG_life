/* =====================================================================
   LIFE RPG — сервер: раздача игры + онлайн-API (живые игроки, чат, поиск)
   Зависимостей нет: нужен только Node.js 18+.

   Запуск локально:      node server.js          → http://localhost:3000
   Запуск на Render.com: Start command: node server.js
                         переменная PORT задаётся самим Render
                         диск: attach Disk → Mount path /opt/render/project/src/data
                               (иначе данные исчезнут при перезапуске)
   Данные:               ./data/db.json (или NET_DB), бэкап db.bak.json
   ===================================================================== */
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');

const ROOT=__dirname;
const PORT=+(process.env.PORT||3000);
const HOST=process.env.HOST||'0.0.0.0';
const DATA_DIR=process.env.NET_DB||path.join(ROOT,'data');
const DB_FILE=path.join(DATA_DIR,'db.json');
const SEASON_DAYS=+(process.env.SEASON_DAYS||5);          /* должен совпадать с клиентом */
const MAXMSG=300;                                          /* сколько сообщений чата храним */
const NICK_MAX=18,MSG_MAX=200;
const AVAS=['🦊','🐼','🐯','🦁','🐸','🐙','🦄','🐲','🐺','🦉','🐨','🐷','🦅','🐢','🦖','🐳','🦋','🐝','🦔','🐿','🦂','🐧','🦜','🐊','🦈','🐆','🦇','🕊','🦩','🙂','😎','🤓','🥷','🧙','🦸','🧑‍🚀','🧑‍🎤','🤖','👾','🐱'];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
 '.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
 '.webmanifest':'application/manifest+json; charset=utf-8','.ico':'image/x-icon','.webp':'image/webp'};

/* ---------------------------- ХРАНИЛИЩЕ ---------------------------- */
let DB={v:1,players:{},byNick:{},messages:[],msgId:0,season:seasonKey(),stats:{reg:0,msg:0}};
function seasonKey(t){const d=new Date(t===undefined?Date.now():t);
 return 's'+Math.floor(Math.floor(new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime()/864e5)/SEASON_DAYS);}
function load(){
 try{fs.mkdirSync(DATA_DIR,{recursive:true});}catch(e){}
 try{
  const raw=JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
  if(raw&&typeof raw==='object'){
   DB.players=raw.players&&typeof raw.players==='object'?raw.players:{};
   DB.messages=Array.isArray(raw.messages)?raw.messages.slice(-MAXMSG):[];
   DB.msgId=+raw.msgId||DB.messages.length;
   DB.stats=raw.stats||DB.stats;
   DB.byNick={};
   Object.keys(DB.players).forEach(id=>{const p=DB.players[id];if(p&&p.nn)DB.byNick[p.nn]=id;});
   console.log('[db] загружено игроков: '+Object.keys(DB.players).length+', сообщений: '+DB.messages.length);
  }
 }catch(e){
  try{
   const bak=JSON.parse(fs.readFileSync(DB_FILE+'.bak','utf8'));
   if(bak&&bak.players){DB.players=bak.players;DB.messages=bak.messages||[];DB.msgId=bak.msgId||0;
    DB.byNick={};Object.keys(DB.players).forEach(id=>{const p=DB.players[id];if(p&&p.nn)DB.byNick[p.nn]=id;});}
  }catch(e2){}
 }
 if(DB.msgId<DB.messages.length)DB.msgId=DB.messages.length;
}
let saveT=null;
function save(){
 if(saveT)return;
 saveT=setTimeout(()=>{
  saveT=null;
  try{
   fs.mkdirSync(DATA_DIR,{recursive:true});
   if(fs.existsSync(DB_FILE))try{fs.copyFileSync(DB_FILE,DB_FILE+'.bak');}catch(e){}
   const tmp=DB_FILE+'.tmp';
   fs.writeFileSync(tmp,JSON.stringify({v:1,players:DB.players,messages:DB.messages.slice(-MAXMSG),msgId:DB.msgId,stats:DB.stats}));
   fs.renameSync(tmp,DB_FILE);
  }catch(e){console.log('[db] не удалось сохранить: '+e.message);}
 },600);
}
function pub(p){
 if(!p)return null;
 return {id:p.id,n:p.n,e:p.e,xp:p.sx||0,lvl:p.lvl||1,st:p.st||0,cls:p.cls||'',
  at:p.at||0,seen:p.seen||0,last:p.last||0,me:0};
}

/* ---------------------------- ВАЛИДАЦИЯ ---------------------------- */
function cleanNick(v){
 if(typeof v!=='string')return null;
 let n=v.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g,'').trim();
 n=n.replace(/[<>{}$`\\|"']/g,'').replace(/\s+/g,' ');
 if(n.length<2||n.length>NICK_MAX)return null;
 if(/(script|javascript|onerror|onload|https?:|data:|www\.)/i.test(n))return null;
 return n;
}
function cleanAvatar(v){
 if(typeof v!=='string')return null;
 const t=[...v.trim()];
 if(!t.length||t.join('').length>8)return null;
 const s=t.slice(0,3).join('');
 return AVAS.includes(s)?s:(AVAS.includes(t[0])?t[0]:null);
}
function cleanText(v,max){
 if(typeof v!=='string')return null;
 let t=v.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g,'').replace(/\s+$/,'');
 if(!t.length||t.length>max)return null;
 return t;
}
function badWord(t){return /(https?:\/\/|www\.|<\s*script|javascript:|data:text\/html)/i.test(t);}

/* ---------------------------- АНТИСПАМ ---------------------------- */
const RL={};
function limited(key,max,win){
 const now=Date.now(),a=(RL[key]=RL[key]||[]).filter(t=>now-t<win);
 a.push(now);RL[key]=a;
 return a.length>max;
}
setInterval(()=>{const now=Date.now();Object.keys(RL).forEach(k=>{RL[k]=RL[k].filter(t=>now-t<60000);if(!RL[k].length)delete RL[k];});},120000).unref();

/* ---------------------------- HTTP-УТИЛИТЫ ---------------------------- */
function json(res,code,o){
 const b=Buffer.from(JSON.stringify(o));
 res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store'});
 res.end(b);
}
function readBody(req,cb){
 let n=0;const ch=[];
 req.on('data',c=>{n+=c.length;if(n>32*1024){req.destroy();return;}ch.push(c);});
 req.on('end',()=>{
  if(n>32*1024)return cb({error:'слишком большой запрос'});
  const raw=Buffer.concat(ch).toString('utf8');
  if(!raw)return cb({});
  try{cb(JSON.parse(raw));}catch(e){cb({error:'некорректный JSON'});}
 });
 req.on('error',()=>cb({error:'ошибка запроса'}));
}
function ipOf(req){
 const xf=req.headers['x-forwarded-for'];
 if(typeof xf==='string'&&xf.length)return xf.split(',')[0].trim();
 return (req.socket&&req.socket.remoteAddress)||'unknown';
}
function sortPlayers(list){return list.sort((a,b)=>(b.sx||0)-(a.sx||0)||(b.lvl||0)-(a.lvl||0)||(a.at||0)-(b.at||0));}

/* ---------------------------- API ---------------------------- */
function apiGet(res,p,u,req){
 const ip=ipOf(req);
 if(p==='/api/health')return json(res,200,{ok:true,v:1,players:Object.keys(DB.players).length,
  messages:DB.messages.length,season:seasonKey(),seasonDays:SEASON_DAYS,time:Date.now()});
 if(p==='/api/state')return json(res,200,{season:seasonKey(),seasonDays:SEASON_DAYS,
  players:Object.keys(DB.players).length,online:0,avatars:AVAS,msgMax:MSG_MAX,nickMax:NICK_MAX});
 if(p==='/api/chat'){
  if(limited('chat-get:'+ip,120,60000))return json(res,429,{error:'слишком часто'});
  const after=+(u.searchParams.get('after')||0);
  let list=DB.messages;
  if(after>0)list=list.filter(m=>m.id>after);
  return json(res,200,{ok:true,messages:list.slice(-120),lastId:DB.msgId,season:seasonKey()});
 }
 if(p==='/api/search'){
  if(limited('search:'+ip,40,60000))return json(res,429,{error:'слишком частые запросы поиска'});
  const q=cleanText(u.searchParams.get('q')||'',NICK_MAX);
  if(!q)return json(res,200,{ok:true,found:[]});
  const ql=q.toLowerCase();
  const res2=[];
  Object.keys(DB.players).forEach(id=>{
   const pl=DB.players[id];
   if(!pl||!pl.n)return;
   const nl=pl.n.toLowerCase();
   const score=nl===ql?0:nl.startsWith(ql)?1:nl.includes(ql)?2:3;
   if(score<3)res2.push({score:score,p:pub(pl)});
  });
  res2.sort((a,b)=>a.score-b.score||(b.p.xp||0)-(a.p.xp||0));
  return json(res,200,{ok:true,found:res2.slice(0,20).map(x=>x.p)});
 }
 if(p==='/api/league'||p==='/api/live'){
  if(limited('league:'+ip,120,60000))return json(res,429,{error:'слишком часто'});
  const want=Math.min(60,Math.max(5,+(u.searchParams.get('n')||30)));
  const s=seasonKey();
  const all=Object.keys(DB.players).map(id=>DB.players[id]).filter(x=>x);
  sortPlayers(all);
  const top=all.slice(0,want).map(pub);
  const tok=u.searchParams.get('token');
  let me=null;
  if(tok){
   const id=Object.keys(DB.players).find(k=>DB.players[k].token===tok);
   if(id){
    const idx=all.findIndex(x=>x.id===id);
    me={place:idx+1,total:all.length,self:pub(DB.players[id])};
    if(idx>=0&&idx<top.length)top[idx].me=1;
   }
  }
  return json(res,200,{ok:true,season:s,seasonDays:SEASON_DAYS,total:all.length,top:top,me:me});
 }
 return json(res,404,{error:'нет такого метода'});
}

function apiPost(res,p,req){
 const ip=ipOf(req);
 readBody(req,body=>{
  if(body&&body.error)return json(res,400,body);
  body=body||{};

  /* ---- регистрация / вход по нику ---- */
  if(p==='/api/register'){
   if(limited('reg:'+ip,25,3600000))return json(res,429,{error:'слишком много попыток, попробуй позже'});
   const nick=cleanNick(body.nick);
   if(!nick)return json(res,400,{error:'Ник: 2–'+NICK_MAX+' символов, без ссылок и спецсимволов'});
   const ava=cleanAvatar(body.ava)||'🙂';
   const nn=nick.toLowerCase();
   const existing=DB.byNick[nn]?DB.players[DB.byNick[nn]]:null;
   const dev=typeof body.device==='string'?body.device.slice(0,80):'';
   const tok=typeof body.token==='string'?body.token.slice(0,80):'';
   /* повторный вход: тот же ник + (то же устройство или тот же токен) */
   if(existing&&((dev&&existing.dev===dev)||(tok&&existing.token===tok))){
    existing.seen=Date.now();save();
    return json(res,200,{ok:true,rejoin:true,id:existing.id,token:existing.token,player:pub(existing)});
   }
   if(existing)return json(res,409,{error:'Ник «'+existing.n+'» уже занят — выбери другой'});
   const id='p'+crypto.randomBytes(6).toString('hex');
   const token=crypto.randomBytes(16).toString('hex');
   const now=Date.now();
   DB.players[id]={id:id,n:nick,nn:nn,e:ava,token:token,dev:dev,
    sx:0,season:seasonKey(),lvl:+body.lvl||1,st:+body.st||0,cls:String(body.cls||'').slice(0,24),
    at:now,seen:now,last:0,msg:0};
   DB.byNick[nn]=id;DB.stats.reg=(DB.stats.reg||0)+1;
   save();
   return json(res,200,{ok:true,id:id,token:token,player:pub(DB.players[id])});
  }

  const playerByToken=()=>{
   const tok=typeof body.token==='string'?body.token:'';
   if(!tok)return null;
   const id=Object.keys(DB.players).find(k=>DB.players[k].token===tok);
   return id?DB.players[id]:null;
  };

  /* ---- свой XP сезона ---- */
  if(p==='/api/xp'){
   const pl=playerByToken();
   if(!pl)return json(res,401,{error:'нет связи с профилем — подключись заново'});
   const s=seasonKey();
   if(pl.season!==s){pl.season=s;pl.sx=0;}
   const xp=Math.max(0,Math.min(1000000,Math.round(+body.xp||0)));
   pl.sx=xp;pl.lvl=Math.max(1,Math.min(999,Math.round(+body.lvl||pl.lvl||1)));
   pl.st=Math.max(0,Math.min(99999,Math.round(+body.streak||pl.st||0)));
   if(typeof body.cls==='string')pl.cls=body.cls.slice(0,24);
   pl.seen=Date.now();save();
   return json(res,200,{ok:true,xp:pl.sp===undefined?pl.sx:pl.sx,season:s});
  }

  /* ---- аватар/класс ---- */
  if(p==='/api/me'){
   const pl=playerByToken();
   if(!pl)return json(res,401,{error:'нет связи с профилем'});
   if(body.ava!==undefined){const a=cleanAvatar(body.ava);if(a)pl.e=a;}
   if(typeof body.nick==='string'){
    const nn2=cleanNick(body.nick);
    if(nn2&&nn2.toLowerCase()!==pl.nn){
     if(DB.byNick[nn2.toLowerCase()])return json(res,409,{error:'Ник «'+nn2+'» уже занят'});
     delete DB.byNick[pl.nn];pl.n=nn2;pl.nn=nn2.toLowerCase();DB.byNick[pl.nn]=pl.id;
    }
   }
   if(typeof body.cls==='string')pl.cls=body.cls.slice(0,24);
   pl.lvl=Math.max(1,Math.min(999,Math.round(+body.lvl||pl.lvl||1)));
   pl.seen=Date.now();save();
   return json(res,200,{ok:true,player:pub(pl)});
  }

  /* ---- сообщение в чат ---- */
  if(p==='/api/chat'){
   const pl=playerByToken();
   if(!pl)return json(res,401,{error:'чтобы писать в чат, подключись (ник + аватар)'});
   if(limited('chat:'+pl.id,10,60000))return json(res,429,{error:'не чаще 10 сообщений в минуту'});
   if(limited('chat-ip:'+ip,40,60000))return json(res,429,{error:'слишком много сообщений с одного адреса'});
   const txt=cleanText(body.text,MSG_MAX);
   if(!txt)return json(res,400,{error:'пустое сообщение или длиннее '+MSG_MAX+' символов'});
   if(badWord(txt))return json(res,400,{error:'ссылки и код в чате запрещены'});
   const now=Date.now();
   if(pl.last&&now-(+pl.last||0)<1800)return json(res,429,{error:'чуть медленнее — одно сообщение в 2 секунды'});
   pl.last=now;
   const s=seasonKey();
   if(pl.season!==s){pl.season=s;pl.sx=0;}
   DB.msgId++;
   const m={id:DB.msgId,n:pl.n,e:pl.e,t:txt,at:now};
   DB.messages.push(m);
   if(DB.messages.length>MAXMSG)DB.messages=DB.messages.slice(-MAXMSG);
   DB.stats.msg=(DB.stats.msg||0)+1;
   save();
   return json(res,200,{ok:true,message:m,lastId:DB.msgId});
  }

  return json(res,404,{error:'нет такого метода'});
 });
}

/* ---------------------------- СТАТИКА ---------------------------- */
function serveStatic(req,res,p){
 let rel=decodeURIComponent(p);
 if(rel==='/'||rel==='')rel='/index.html';
 const f=path.join(ROOT,path.normalize(rel).replace(/^([.][.][\/\\])+/,''));
 if(!f.startsWith(ROOT)){res.writeHead(403);return res.end('no');}
 fs.readFile(f,(e,d)=>{
  if(e){
   /* SPA-fallback: любой неизвестный путь отдаёт игру */
   fs.readFile(path.join(ROOT,'index.html'),(e2,d2)=>{
    if(e2){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('not found');}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(d2);
   });
   return;
  }
  const ext=path.extname(f).toLowerCase();
  res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream',
   'Cache-Control':ext==='.html'?'no-store':'no-cache'});
  res.end(d);
 });
}

/* ---------------------------- СЕРВЕР ---------------------------- */
load();
const server=http.createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('Access-Control-Allow-Headers','Content-Type');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
 let p='/';
 try{p=decodeURIComponent((req.url||'/').split('?')[0]);}catch(e){}
 const u=new URL(req.url||'/','http://localhost');
 try{
  if(p.startsWith('/api/')){
   if(req.method==='GET')return apiGet(res,p,u,req);
   if(req.method==='POST')return apiPost(res,p,req);
   return json(res,405,{error:'метод не поддерживается'});
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'метод не поддерживается'});
  serveStatic(req,res,p);
 }catch(err){
  console.log('[err] '+((err&&err.stack)||err));
  try{json(res,500,{error:'внутренняя ошибка сервера'});}catch(e){}
 }
});
server.listen(PORT,HOST,()=>{
 console.log('LIFE RPG → http://'+HOST+':'+PORT);
 console.log('  игра:    /index.html');
 console.log('  API:     /api/health /api/state /api/register /api/xp /api/league /api/chat /api/search');
 console.log('  данные:  '+DB_FILE+' (сезон '+seasonKey()+', '+SEASON_DAYS+' дней)');
 /* на Render бесплатный инстанс не умеет диски — предупреждаем, что база временная */
 try{
  const onRender=!!process.env.RENDER;
  if(onRender){
   const dir=path.dirname(DB_FILE);
   let writable=false;
   try{fs.mkdirSync(dir,{recursive:true});
    const probe=path.join(dir,'.probe-'+Date.now());
    fs.writeFileSync(probe,'1');writable=fs.existsSync(probe);fs.rmSync(probe,{force:true});}catch(e){writable=false;}
   console.log('  render:  '+(process.env.RENDER_SERVICE_ID||'-')+' · план '+(process.env.RENDER_INSTANCE_TYPE||'?'));
   if(!writable)console.log('  ⚠️  каталог базы не доступен на запись: '+dir);
   if(!/\/(var|opt)\//.test(DB_FILE)){
    console.log('  ⚠️  база пишется во временную файловую систему: после деплоя/перезапуска игроки и чат обнулятся.');
    console.log('     решение: прикрепи диск (только платный инстанс) и задай NET_DB=/var/data — см. render.disk.yaml');
   }else{
    console.log('  ✅ база на примонтированном диске: '+path.dirname(DB_FILE));
   }
  }
 }catch(e){}
});
