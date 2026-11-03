package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/agent"
	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/matrix"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

type managementTest struct {
	s       *store.Store
	handler http.Handler
	token   string
	admin   *core.Record
}

func management(t *testing.T) managementTest {
	t.Helper()
	s := testutil.Store(t)
	m := agent.New(s, nil, nil)
	t.Cleanup(m.Close)
	routes, err := apis.NewRouter(s.App)
	if err != nil {
		t.Fatal(err)
	}
	Admin{Manager: m, Matrix: matrix.Factory{Store: s}, PersonProfileLookup: func(context.Context, string) (matrix.PersonProfile, error) {
		return matrix.PersonProfile{DisplayName: "Matrix display name"}, nil
	}}.Register(&core.ServeEvent{App: s.App, Router: routes})
	handler, err := routes.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	col, _ := s.App.FindCollectionByNameOrId("_superusers")
	r := core.NewRecord(col)
	r.SetEmail("management@example.test")
	r.SetPassword("synthetic-management-password")
	if err = s.App.Save(r); err != nil {
		t.Fatal(err)
	}
	token, err := r.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	return managementTest{s, handler, token, r}
}
func (m managementTest) request(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	m.handler.ServeHTTP(w, r)
	return w
}
func (m managementTest) bearer(method, path, body string) *httptest.ResponseRecorder {
	return m.request(method, path, body, map[string]string{"Authorization": m.token})
}
func TestSessionsRequireCSRFAndRevoke(t *testing.T) {
	m := management(t)
	w := m.bearer("POST", "/api/post/session", "{}")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("session cookie is not protected")
	}
	var session map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &session)
	headers := map[string]string{"Cookie": cookies[0].String()}
	if w = m.request("GET", "/api/post/session", "", headers); w.Code != 200 {
		t.Fatal("session did not survive a fresh request")
	}
	if w = m.request("POST", "/api/post/profile", `{"mxid":"@owner:example.test"}`, headers); w.Code != 403 {
		t.Fatal("missing CSRF header was accepted")
	}
	headers["X-Pith-CSRF"] = session["csrf"]
	headers["Origin"] = "https://unrelated.example.test"
	if w = m.request("POST", "/api/post/profile", `{"mxid":"@owner:example.test"}`, headers); w.Code != 403 {
		t.Fatal("foreign origin was accepted")
	}
	delete(headers, "Origin")
	if w = m.request("POST", "/api/post/profile", `{"mxid":"@owner:example.test"}`, headers); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = m.request("DELETE", "/api/post/session", "", headers); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = m.request("GET", "/api/post/agents", "", headers); w.Code != 401 {
		t.Fatal("logged-out session was reused")
	}
	w = m.bearer("POST", "/api/post/session", "{}")
	cookies = w.Result().Cookies()
	headers["Cookie"] = cookies[0].String()
	m.admin.RefreshTokenKey()
	if err := m.s.App.Save(m.admin); err != nil {
		t.Fatal(err)
	}
	if w = m.request("GET", "/api/post/session", "", headers); w.Code != 401 {
		t.Fatal("session survived credential revocation")
	}
}
func TestUnifiedSetupIsAtomicIdempotentAndSecretsStayPrivate(t *testing.T) {
	m := management(t)
	for _, path := range []string{"/api/post/owners", "/api/post/connections", "/api/post/profile", "/api/post/draft"} {
		if w := m.request("GET", path, "", nil); w.Code != 401 {
			t.Fatalf("anonymous read %s", path)
		}
	}
	for _, path := range []string{"/api/post/assistants", "/api/post/connections", "/api/post/draft", "/api/post/session"} {
		if w := m.request("POST", path, "{}", nil); w.Code != 401 {
			t.Fatalf("anonymous write %s", path)
		}
	}
	w := m.bearer("POST", "/api/post/connections", `{"name":"Test model","url":"http://127.0.0.1:11434/v1","model":"synthetic","api":"openai-completions","context_window":8192,"max_tokens":1024,"key":"synthetic-shared-key"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if strings.Contains(w.Body.String(), "synthetic-shared-key") {
		t.Fatal("connection response exposed key")
	}
	var c store.Connection
	_ = json.Unmarshal(w.Body.Bytes(), &c)
	in := assistantInput{RequestID: "setup-request-one", Name: "Helper", Prompt: "Be helpful.", OwnerName: "Person", OwnerMXID: "@person:example.test", Bot: "@helper:example.test", Homeserver: "https://matrix.example.test", Connection: c.ID, Password: "synthetic-bot-key"}
	raw, _ := json.Marshal(in)
	w = m.bearer("POST", "/api/post/assistants", string(raw))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	id := result["id"]
	w = m.bearer("POST", "/api/post/assistants", string(raw))
	var duplicate map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &duplicate)
	if w.Code != 200 || duplicate["id"] != id {
		t.Fatal("setup retry created another assistant")
	}
	config, err := m.s.Config(id)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := m.s.State(id)
	if config.AutoStart || st.Room != "" || st.Device != "" {
		t.Fatal("saving setup initialized an external identity")
	}
	_, key, err := m.s.GenerationConfig(id)
	if err != nil || key != "synthetic-shared-key" {
		t.Fatal("shared model key not used")
	}
	w = m.bearer("GET", "/api/post/agents", "")
	if strings.Contains(w.Body.String(), "synthetic-shared-key") || strings.Contains(w.Body.String(), "synthetic-bot-key") {
		t.Fatal("list exposed credentials")
	}
	if w = m.bearer("DELETE", "/api/post/connections/"+c.ID, ""); w.Code != 400 {
		t.Fatal("referenced connection was deleted")
	}
	before, _ := m.s.App.FindAllRecords("owners")
	in.RequestID = "failed-request"
	in.OwnerMXID = "@invalid:example.test"
	in.Bot = in.OwnerMXID
	raw, _ = json.Marshal(in)
	if w = m.bearer("POST", "/api/post/assistants", string(raw)); w.Code != 400 {
		t.Fatal("same owner/bot accepted")
	}
	after, _ := m.s.App.FindAllRecords("owners")
	if len(before) != len(after) {
		t.Fatal("failed setup left an orphan owner")
	}
	w = m.bearer("POST", "/api/post/draft", `{"request_id":"safe-draft","step":1,"password":"must-not-be-stored"}`)
	if w.Code != 400 {
		t.Fatal("draft accepted credentials")
	}
	patch := map[string]any{"name": "Updated", "prompt": "New instructions", "connection": c.ID, "revision": revision(config)}
	raw, _ = json.Marshal(patch)
	if w = m.bearer("PATCH", "/api/post/assistants/"+id, string(raw)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = m.bearer("PATCH", "/api/post/assistants/"+id, string(raw)); w.Code != 409 {
		t.Fatal("stale edit overwrote a newer version")
	}
	secrets, err := m.s.Secrets(id)
	if err != nil || secrets.Password != "synthetic-bot-key" {
		t.Fatal("editing lost Matrix credentials")
	}
}
func TestModelCheckDoesNotForwardKeysAcrossRedirects(t *testing.T) {
	m := management(t)
	received := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received = true; w.WriteHeader(200) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-check-key" {
			t.Error("configured key missing")
		}
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer server.Close()
	c := store.Connection{ID: "redirect-test", Name: "Redirect test", URL: server.URL, API: "openai-completions", Model: "test", Context: 8192, MaxTokens: 1024}
	key := "synthetic-check-key"
	if err := m.s.SaveConnection(c, &key); err != nil {
		t.Fatal(err)
	}
	w := m.bearer("POST", "/api/post/connections/redirect-test/check", "{}")
	if w.Code != 200 || received {
		t.Fatal("model check followed a credential-bearing redirect")
	}
	if strings.Contains(w.Body.String(), key) {
		t.Fatal("model check exposed credential")
	}
}

func TestRemoveAgentKeepsUnfinishedWorkAndIdentityArchives(t *testing.T) {
	m := management(t)
	c := testutil.Agent(t, m.s, "remove-unfinished")
	run, err := m.s.Enqueue(c.ID, "proactive:unfinished", "Do not replay this task")
	if err != nil {
		t.Fatal(err)
	}
	if err = m.s.PutSecrets(c.ID, domain.Secrets{Password: "synthetic-retained-secret"}); err != nil {
		t.Fatal(err)
	}
	state, err := m.s.State(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	r, _ := m.s.App.FindRecordById("agents", c.ID)
	r.Set("auto_start", true)
	if err = m.s.App.Save(r); err != nil {
		t.Fatal(err)
	}
	path := "/api/post/assistants/" + c.ID
	if w := m.request("DELETE", path, "", nil); w.Code != 401 {
		t.Fatal("anonymous removal")
	}
	if w := m.bearer("DELETE", path, ""); w.Code != 200 {
		t.Fatal("unfinished work prevented explicit configuration removal", w.Body.String())
	}
	if _, err = m.s.Config(c.ID); err == nil {
		t.Fatal("configuration still present")
	}
	runs, _, err := m.s.History(c.ID)
	if err != nil || len(runs) != 1 || runs[0].ID != run || runs[0].Status != "queued" {
		t.Fatal("unfinished archive was changed or lost")
	}
	secrets, err := m.s.Secrets(c.ID)
	if err != nil || secrets.Password != "synthetic-retained-secret" {
		t.Fatal("identity archive was lost")
	}
	after, err := m.s.State(c.ID)
	if err != nil || after.Device != state.Device || after.Generation != state.Generation {
		t.Fatal("crypto identity changed")
	}
	if w := m.bearer("DELETE", "/api/post/owners/"+c.OwnerID, ""); w.Code != 200 {
		t.Fatal("removed agent kept its person locked", w.Body.String())
	}
}
