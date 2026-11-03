package admin

import (
	"context"
	"encoding/json"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/pocketbase/core"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSharedSetupIsInheritedWithoutRetargetingExistingAssistants(t *testing.T) {
	m := management(t)
	original := testutil.Agent(t, m.s, "existing-defaults")
	for _, method := range []string{"GET", "POST"} {
		if w := m.request(method, "/api/post/defaults", "{}", nil); w.Code != 401 {
			t.Fatal("shared settings exposed")
		}
	}
	w := m.bearer("POST", "/api/post/connections", `{"url":"http://127.0.0.1:1/v1","model":"local-model","api":"openai-completions","context_window":8192,"max_tokens":1024}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var connection map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &connection)
	if connection["name"] != "local-model" {
		t.Fatal("unnecessary model display name was required")
	}
	connectionID := connection["id"].(string)
	w = m.bearer("GET", "/api/post/defaults", "")
	var defaults SetupDefaults
	_ = json.Unmarshal(w.Body.Bytes(), &defaults)
	if defaults.Homeserver != original.Homeserver || defaults.Connection != connectionID {
		t.Fatal("existing setup was not reused")
	}
	w = m.bearer("POST", "/api/post/defaults", `{"homeserver":"http://127.0.0.1:1","connection":"`+connectionID+`"}`)
	if w.Code != 400 {
		t.Fatal("connected agents allowed changing the unique server")
	}
	in := assistantInput{RequestID: "shared-first", Name: "Second", Prompt: "Be helpful", OwnerMXID: "@jamie:example.test", Bot: "@second:example.test", Password: "synthetic-password"}
	raw, _ := json.Marshal(in)
	w = m.bearer("POST", "/api/post/assistants", string(raw))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var created map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	c, err := m.s.Config(created["id"])
	if err != nil || c.Homeserver != original.Homeserver || c.Connection != connectionID || c.OwnerName != "jamie" || c.AutoStart {
		t.Fatal("shared defaults or optional name failed")
	}
	old, _ := m.s.Config(original.ID)
	if old.Homeserver != original.Homeserver || old.Bot != original.Bot {
		t.Fatal("shared setting changed an existing Matrix identity")
	}
	in.RequestID = "shared-override"
	in.Name = "Third"
	in.Bot = "@third:example.test"
	in.Homeserver = "http://127.0.0.1:2"
	raw, _ = json.Marshal(in)
	w = m.bearer("POST", "/api/post/assistants", string(raw))
	if w.Code != 400 {
		t.Fatal("per-agent server override was accepted")
	}
	w = m.bearer("GET", "/api/post/defaults", "")
	_ = json.Unmarshal(w.Body.Bytes(), &defaults)
	if defaults.Homeserver != original.Homeserver {
		t.Fatal("one-off override changed the shared server")
	}
}

func TestServerSettingsValidateConnectionsAndRequireEmptyPeopleAndAgents(t *testing.T) {
	m := management(t)
	matrix := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_matrix/client/versions" || r.Method != "GET" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("probe sent credentials or used the wrong endpoint")
		}
		_, _ = w.Write([]byte(`{"versions":["v1.11"]}`))
	}))
	defer matrix.Close()
	body := func(address string) string {
		b, _ := json.Marshal(map[string]string{"homeserver": address})
		return string(b)
	}
	if w := m.request("POST", "/api/post/defaults/check", body(matrix.URL), nil); w.Code != 401 {
		t.Fatal("anonymous connection check allowed")
	}
	if w := m.bearer("POST", "/api/post/defaults/check", body(matrix.URL)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	defaults, _ := setupDefaults(m.s.App)
	if defaults.Homeserver != "" {
		t.Fatal("connection check changed settings")
	}
	if w := m.bearer("POST", "/api/post/defaults", body(" "+matrix.URL+"/ ")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w := m.bearer("POST", "/api/post/owners", `{"mxid":"@person:example.test"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var person map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &person)
	if w = m.bearer("POST", "/api/post/defaults", body("http://127.0.0.1:1")); w.Code != 400 || !strings.Contains(w.Body.String(), "Remove all agents and people") {
		t.Fatal("person without an agent did not lock server", w.Body.String())
	}
	if w = m.bearer("POST", "/api/post/defaults/check", body(matrix.URL)); w.Code != 200 {
		t.Fatal("locked server could not be checked")
	}
	if w = m.bearer("DELETE", "/api/post/owners/"+person["id"], ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"versions":[]}`)) }))
	defer bad.Close()
	if w = m.bearer("POST", "/api/post/defaults", body(bad.URL)); w.Code != 400 {
		t.Fatal("invalid Matrix endpoint was saved")
	}
	defaults, _ = setupDefaults(m.s.App)
	if defaults.Homeserver != matrix.URL {
		t.Fatal("failed save changed server")
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"versions":["v1.12"]}`)) }))
	defer other.Close()
	if w = m.bearer("POST", "/api/post/defaults", body(other.URL)); w.Code != 200 {
		t.Fatal("empty configuration could not change server", w.Body.String())
	}
	defaults, _ = setupDefaults(m.s.App)
	if defaults.Homeserver != other.URL {
		t.Fatal("new server not saved")
	}
}

func TestMatrixServerProbeRejectsRedirectsInvalidURLsAndUnreachableServers(t *testing.T) {
	reached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		_, _ = w.Write([]byte(`{"versions":["v1.11"]}`))
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer redirect.Close()
	for _, address := range []string{redirect.URL, "http://127.0.0.1:1", "file:///etc/passwd", "https://user:password@example.test", "https://example.test/?token=secret"} {
		if err := checkMatrixServer(context.Background(), address); err == nil {
			t.Fatalf("accepted %s", address)
		}
	}
	if reached {
		t.Fatal("connection check followed a redirect")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if err := checkMatrixServer(ctx, target.URL); err == nil || time.Since(start) > time.Second {
		t.Fatal("probe ignored cancellation")
	}
}

func TestServerChangeRechecksPeopleAddedDuringConnectionProbe(t *testing.T) {
	m := management(t)
	matrix := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		col, _ := m.s.App.FindCollectionByNameOrId("owners")
		person := core.NewRecord(col)
		person.Set("mxid", "@new:example.test")
		person.Set("name", "New")
		if err := m.s.App.Save(person); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"versions":["v1.11"]}`))
	}))
	defer matrix.Close()
	raw, _ := json.Marshal(map[string]string{"homeserver": matrix.URL})
	w := m.bearer("POST", "/api/post/defaults", string(raw))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "Remove all agents and people") {
		t.Fatal("concurrent person creation did not prevent server change", w.Body.String())
	}
	defaults, _ := setupDefaults(m.s.App)
	if defaults.Homeserver != "" {
		t.Fatal("concurrent server change was saved")
	}
}
