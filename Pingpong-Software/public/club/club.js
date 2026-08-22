/* PingPong Club frontend. Real data only; no demo users are seeded. */
const CLUB_API_BASE = "/api/clubs";

const state = { me:null, myClub:null, recommendations:[], ranking:[] };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(msg){ const el=$("#toast"); el.textContent=msg; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2400); }
function avatar(url){ return url || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='%23343b58'/%3E%3Ccircle cx='50' cy='42' r='22' fill='%238d96b5'/%3E%3Cpath d='M18 92c6-24 58-24 64 0' fill='%238d96b5'/%3E%3C/svg%3E"; }

async function api(path, options={}){
  const r=await fetch(CLUB_API_BASE+path,{credentials:"include",headers:{"Content-Type":"application/json",...(localStorage.getItem("pp_auth_token")?{"Authorization":"Bearer "+localStorage.getItem("pp_auth_token")}:{}),...(options.headers||{})},...options});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||"Request failed");
  return data;
}

async function load(){
  try{
    const d=await api("/me");
    state.me=d.user; state.myClub=d.club||null;
    state.recommendations=d.recommendations||[];
    renderHome();
    await loadRanking();
  }catch(e){ toast(e.message); }
}

async function loadRanking(){
  const d=await api("/ranking");
  state.ranking=d.ranking||[];
  $("#rankingPeriod").textContent=d.period||"Current month";
  renderRanking();
}

function renderHome(){
  const c=state.myClub;
  $("#myClubName").textContent=c?.name||"No club yet";
  $("#myClubMeta").textContent=c?`${c.level} • ${Number(c.exp||0).toLocaleString()} EXP • ${c.memberCount||0} members`:"Create or join a club to start.";
  $("#myClubBadge").textContent=c?`${c.level} • ${c.labelStyle||"CLUB"}`:"—";

  const actions=[];
  if(c) actions.push(`<button class="primary-btn" data-action="clubDetails">Open Club</button>`,
                     `<button class="secondary-btn" data-action="invite">Invite User</button>`,
                     `<button class="danger-btn" data-action="leave">Leave Club</button>`);
  else actions.push(`<button class="primary-btn" data-action="create">＋ Create a Club</button>`);
  $("#clubActions").innerHTML=actions.join("");

  if(!state.recommendations.length){
    $("#recommendList").innerHTML=`<div class="empty">No recommended clubs yet.</div>`;
  }else{
    $("#recommendList").innerHTML=state.recommendations.map(c=>`
      <div class="club-card">
        <img class="avatar" src="${esc(avatar(c.avatarUrl))}" alt="">
        <div class="grow"><h3>${esc(c.name)}</h3><p>${esc(c.level)} • ${Number(c.exp||0).toLocaleString()} EXP • ${c.memberCount||0} members</p></div>
        <button class="secondary-btn" data-join="${esc(c.id)}">Join</button>
      </div>`).join("");
  }
}

function renderRanking(){
  const r=state.ranking;
  $("#topThree").innerHTML=r.slice(0,3).map((c,i)=>`
    <div class="rank-podium ${i===0?"first":""}">
      <div class="rank-num">#${i+1}</div>
      <img src="${esc(avatar(c.avatarUrl))}" alt="">
      <h3>${esc(c.name)}</h3><p>${Number(c.exp||0).toLocaleString()} EXP</p>
    </div>`).join("");
  $("#rankingList").innerHTML=r.length?r.map((c,i)=>`
    <div class="rank-row">
      <div class="rank-pos">${i+1}</div>
      <img src="${esc(avatar(c.avatarUrl))}" alt="">
      <div class="grow"><h3>${esc(c.name)}</h3><p>${esc(c.level)} • ${c.memberCount||0} members</p></div>
      <div class="exp">${Number(c.exp||0).toLocaleString()}</div>
    </div>`).join(""):`<div class="empty">No club ranking data yet.</div>`;
}

function openModal(title, body){
  $("#modalContent").innerHTML=`<h2>${title}</h2>${body}`;
  $("#modal").classList.remove("hidden");
}
function closeModal(){ $("#modal").classList.add("hidden"); }

async function showCreate(){
  openModal("Create a Club",`
    <form id="createForm">
      <div class="field"><label>Club name</label><input name="name" maxlength="40" required></div>
      <div class="field"><label>Club avatar URL (optional)</label><input name="avatarUrl" type="url"></div>
      <div class="field"><label>Club label style</label><select name="labelStyle"><option>steel</option><option>bronze</option><option>silver</option><option>gold</option></select></div>
      <button class="primary-btn" type="submit">Create Club</button>
    </form>`);
  $("#createForm").onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(e.target);
    try{ await api("",{method:"POST",body:JSON.stringify(Object.fromEntries(f))}); closeModal(); toast("Club created"); await load(); }
    catch(err){toast(err.message)}
  };
}

async function showClubDetails(){
  const d=await api(`/${encodeURIComponent(state.myClub.id)}`);
  const members=d.members||[];
  openModal(esc(d.club.name),`
    <p>${esc(d.club.level)} • ${Number(d.club.exp||0).toLocaleString()} EXP • ${members.length}/${d.club.maxMembers} members</p>
    <div class="action-row"><button class="secondary-btn" data-action="invite">Invite User</button></div>
    <div>${members.map(m=>`
      <div class="member-row">
        <img class="avatar" src="${esc(avatar(m.avatarUrl))}" alt="">
        <div class="grow"><b>${esc(m.name)}</b><div class="role">${esc(m.role)}</div></div>
        ${["owner","co-leader","admin"].includes(state.myClub.myRole)&&m.id!==state.me.id?`<button class="danger-btn" data-remove="${esc(m.id)}">Remove</button>`:""}
      </div>`).join("")}</div>`);
}

async function showInvite(){
  openModal("Invite a User",`
    <form id="inviteForm">
      <div class="field"><label>User ID / username</label><input name="userId" required></div>
      <button class="primary-btn" type="submit">Send Invite</button>
    </form>`);
  $("#inviteForm").onsubmit=async e=>{
    e.preventDefault(); const userId=new FormData(e.target).get("userId");
    try{await api(`/${encodeURIComponent(state.myClub.id)}/invites`,{method:"POST",body:JSON.stringify({userId})});closeModal();toast("Invitation sent");}
    catch(err){toast(err.message)}
  };
}

document.addEventListener("click",async e=>{
  const a=e.target.closest("[data-action]")?.dataset.action;
  if(a==="back") return history.back();
  if(a==="help") return openModal("Club Help", `<p>Create or join one real club. Club EXP comes only from confirmed gifts made by club members. Your wallet and gift system remain the source of truth.</p><p>Owner and staff roles are enforced server-side.</p>`);
  if(a==="create") return showCreate();
  if(a==="closeModal") return closeModal();
  if(a==="clubDetails") return showClubDetails();
  if(a==="invite") return showInvite();
  if(a==="refresh") return loadRanking();
  if(a==="leave"){
    if(!confirm("Leave this club?")) return;
    try{await api(`/${encodeURIComponent(state.myClub.id)}/leave`,{method:"POST"});toast("Left club");await load();}
    catch(err){toast(err.message)}
  }
  const join=e.target.closest("[data-join]")?.dataset.join;
  if(join){
    try{await api(`/${encodeURIComponent(join)}/join`,{method:"POST"});toast("Joined club");await load();}
    catch(err){toast(err.message)}
  }
  const remove=e.target.closest("[data-remove]")?.dataset.remove;
  if(remove){
    try{await api(`/${encodeURIComponent(state.myClub.id)}/members/${encodeURIComponent(remove)}`,{method:"DELETE"});toast("Member removed");await showClubDetails();}
    catch(err){toast(err.message)}
  }
});
document.addEventListener("click",e=>{
  const tab=e.target.closest("[data-tab]"); if(!tab)return;
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));tab.classList.add("active");
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("active"));
  $(`#${tab.dataset.tab}View`).classList.add("active");
});
load();
