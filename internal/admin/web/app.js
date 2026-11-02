"use strict";
let token = "";
let credentialAgent = "";
const el = (id) => document.getElementById(id);
const notice = (text) => { el("notice").textContent = text; };
async function request(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "omit" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}
function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
async function operation(id, action, body = {}) {
  await request("/api/post/agents/" + encodeURIComponent(id) + "/" + action, body);
  notice("Operation completed: " + action);
  await refresh();
}
function button(label, fn) {
  const b = node("button", label);
  b.onclick = async () => { b.disabled = true; try { await fn(); } catch (error) { notice(error.message); } finally { b.disabled = false; } };
  return b;
}
async function refresh() {
  const agents = await request("/api/post/agents");
  el("agents").replaceChildren();
  if (!agents.length) el("agents").append(node("p", "Create an owner and agent in the configuration dashboard, then refresh to enter credentials."));
  const grouped = new Map();
  for (const agent of agents) {
    const owner = agent.config.owner;
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(agent);
  }
  for (const [owner, entries] of grouped) {
    el("agents").append(node("h2", owner, "owner"));
    for (const entry of entries) {
      const c = entry.config;
      const card = node("article", undefined, "card");
      card.append(node("h3", c.name), node("div", entry.running ? "Running" : "Stopped", "status"));
      card.append(node("p", c.bot + " · " + c.model, "meta"));
      card.append(node("p", "Room: " + (entry.state.room || "Not bound") + " · Device: " + (entry.state.device || "Not initialized") + " · Conversation: " + entry.state.conversation, "meta"));
      if (entry.state.paused) card.append(node("p", "Paused: " + entry.state.paused));
      if (entry.state.last_error) card.append(node("p", entry.state.last_error));
      if (entry.review) card.append(node("p", "Interrupted execution requires review. No automatic replay."));
      const controls = node("div", undefined, "controls");
      for (const action of ["start", "stop", "restart", "resume"]) controls.append(button(action[0].toUpperCase() + action.slice(1), () => operation(c.id, action)));
      controls.append(button("Credentials", () => { credentialAgent = c.id; el("credential-form").reset(); el("credentials").showModal(); }));
      controls.append(button("History", async () => { const data = await request("/api/post/agents/" + c.id + "/history"); el("history-content").textContent = JSON.stringify(data, null, 2); el("history").hidden = false; el("history").scrollIntoView(); }));
      controls.append(button("Proactive task", async () => { const prompt = window.prompt("Ask Pith to prepare content for the owner. No new inbound message is required."); if (prompt) await operation(c.id, "trigger", { key: crypto.randomUUID(), prompt }); }));
      controls.append(button("New conversation", async () => { if (confirm("The agent must be stopped with no pending work. Keep the Matrix identity and archive the current conversation?")) await operation(c.id, "new-conversation"); }));
      controls.append(button("Review interrupted run", async () => { const run = window.prompt("Run ID from history:"); if (!run) return; const replay = confirm("Replay this run? Choose Cancel to mark it reviewed without replay. Verify possible external effects first."); if (confirm("I have reviewed all possible external effects and the partial conversation.")) await operation(c.id, "review", { run, replay, confirm_external_effects_reviewed: true }); }));
      controls.append(button("Reset encryption identity", async () => { if (!confirm("This is NOT a restart. Restore the original crypto store and master key first. Continue only if recovery is confirmed impossible. The agent must be stopped with all work resolved.")) return; const reason = window.prompt("Record why recovery is impossible (10–500 bytes, no secrets):"); if (reason && confirm("Create a replacement device? Old encrypted history may be unreadable. This reset can run only once.")) await operation(c.id, "reset-identity", { reason, confirm_recovery_impossible: true }); }));
      card.append(controls);
      el("agents").append(card);
    }
  }
}
el("login-form").onsubmit = async (event) => {
  event.preventDefault(); const form = new FormData(event.target);
  try {
    const data = await request("/api/collections/_superusers/auth-with-password", { identity: form.get("identity"), password: form.get("password") });
    token = data.token; event.target.reset(); el("login").hidden = true; el("refresh").hidden = false; el("logout").hidden = false; notice(""); await refresh();
  } catch (error) { notice(error.message); }
};
el("refresh").onclick = () => refresh().catch((error) => notice(error.message));
el("logout").onclick = () => { token = ""; location.reload(); };
el("cancel-credentials").onclick = () => { el("credential-form").reset(); el("credentials").close(); };
el("credential-form").onsubmit = async (event) => {
  event.preventDefault(); const body = {};
  for (const [key, value] of new FormData(event.target)) if (value) body[key] = value;
  event.target.reset(); el("credentials").close();
  try { await operation(credentialAgent, "credentials", body); } catch (error) { notice(error.message); }
};
