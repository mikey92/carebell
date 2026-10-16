// The MCP App card (ui://carebell/visit-card): a self-contained page the host renders in a
// sandboxed iframe and feeds the tool result over postMessage (MCP Apps, SEP-1865).

export function visitCardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1720;--card:#16212c;--ink:#eef3f7;--mute:#93a4b4;--ok:#3ecf8e;--warn:#f5b84b;--bad:#ff6b6b;--blue:#5fb3ff}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{padding:16px}h1{font-size:20px;margin:0 0 2px}.sub{color:var(--mute);margin:0 0 14px}
.v{display:flex;gap:12px;padding:12px;border-radius:14px;background:var(--card);margin-bottom:10px}
.dot{width:12px;height:12px;border-radius:50%;margin-top:5px;flex:none}
.scheduled .dot{background:var(--mute)}.on_site .dot{background:var(--blue);box-shadow:0 0 0 4px #5fb3ff33}
.completed .dot{background:var(--ok)}.late .dot{background:var(--warn)}.missed .dot{background:var(--bad)}
.t{font-weight:600}.m{color:var(--mute);font-size:13px}.flag{color:var(--warn);font-size:13px}
.badge{float:right;font-size:12px;padding:2px 8px;border-radius:99px;background:#ffffff14;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.focus{outline:2px solid var(--blue)}
</style></head><body><div class="wrap" id="root"><p class="sub">Waiting for CareBell…</p></div>
<script>
const LABEL={scheduled:"Scheduled",on_site:"With client",completed:"Done",late:"Late",missed:"Missed"};
const tm=ms=>new Date(ms).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
function render(d){
  if(!d||!d.visits)return;
  const r=document.getElementById("root");
  const who=d.client||"Today";
  r.innerHTML="<h1>"+who+"</h1><p class='sub'>Visits today · checked by the Ring doorbell</p>"+d.visits.map(v=>{
    const a=v.aide.name.split(" ")[0];
    const line=v.status==="completed"?"Arrived "+tm(v.checkIn)+" · left "+tm(v.checkOut):v.status==="on_site"?"Arrived "+tm(v.checkIn)+" · "+Math.round((d.now-v.checkIn)/60000)+" min so far":v.status==="late"?"Due "+tm(v.start)+" · not at the door yet":v.status==="missed"?"Due "+tm(v.start)+" · nobody came":"Due "+tm(v.start)+" – "+tm(v.end);
    return "<div class='v "+v.status+(v.id===d.current?" focus":"")+"'><div class='dot'></div><div style='flex:1'><span class='badge'>"+LABEL[v.status]+"</span><div class='t'>"+a+" · "+v.client.name+"</div><div class='m'>"+line+"</div><div class='m'>"+v.tasks.join(" · ")+"</div>"+(v.flags||[]).map(f=>"<div class='flag'>⚠ "+f+"</div>").join("")+"</div></div>";
  }).join("");
}
let id=1;
function rpc(method,params){parent.postMessage({jsonrpc:"2.0",id:id++,method,params},"*")}
addEventListener("message",e=>{
  const m=e.data||{};
  if(m.method==="ui/notifications/tool-result")render(m.params&&(m.params.structuredContent||m.params));
  else if(m.structuredContent)render(m.structuredContent);
});
rpc("ui/initialize",{appInfo:{name:"CareBell visit card",version:"0.1.0"},appCapabilities:{},protocolVersion:"2026-01-26"});
</script></body></html>`;
}
