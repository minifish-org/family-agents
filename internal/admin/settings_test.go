package admin

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/pocketbase/core"
)

func TestPeopleManagementPreservesConversationOwnership(t *testing.T) {
	m := management(t)
	a := testutil.Agent(t, m.s, "person-settings")
	for _, route := range []struct{ method, path string }{{"POST", "/api/post/owners"}, {"PATCH", "/api/post/owners/unknown"}, {"DELETE", "/api/post/owners/unknown"}, {"GET", "/api/post/account"}, {"POST", "/api/post/account/password"}} {
		if w := m.request(route.method, route.path, "{}", nil); w.Code != 401 {
			t.Fatalf("guest accessed %s", route.path)
		}
	}
	if w := m.bearer("DELETE", "/api/post/owners/"+a.OwnerID, ""); w.Code != 400 {
		t.Fatal("removed a person with an assistant")
	}
	w := m.bearer("PATCH", "/api/post/owners/"+a.OwnerID, `{"name":"Updated name","mxid":"`+a.Owner+`"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	updated, err := m.s.Config(a.ID)
	if err != nil || updated.OwnerName != "Matrix display name" || updated.Owner != a.Owner || updated.OwnerID != a.OwnerID {
		t.Fatal("rename changed conversation ownership")
	}
	if w = m.bearer("PATCH", "/api/post/owners/"+a.OwnerID, `{"name":"Retarget","mxid":"@another:example.test"}`); w.Code != 400 {
		t.Fatal("person identity was retargeted")
	}
	body := `{"name":"Unused person","mxid":"@unused:example.test"}`
	w = m.bearer("POST", "/api/post/owners", body)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var created map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if w = m.bearer("POST", "/api/post/owners", body); w.Code != 400 {
		t.Fatal("duplicate Matrix ID accepted")
	}
	if w = m.bearer("DELETE", "/api/post/owners/"+created["id"], ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err = m.s.App.FindRecordById("owners", a.OwnerID); err != nil {
		t.Fatal("original person was lost")
	}
}

func TestPasswordChangeReauthenticatesAndRevokesSessions(t *testing.T) {
	m := management(t)
	var session map[string]string
	w := m.bearer("POST", "/api/post/session", "{}")
	_ = json.Unmarshal(w.Body.Bytes(), &session)
	headers := map[string]string{"Cookie": w.Result().Cookies()[0].String(), "X-Pith-CSRF": session["csrf"]}
	_ = m.bearer("POST", "/api/post/session", "{}") // another browser session
	newPassword := "replacement-synthetic-password"
	for _, body := range []string{
		`{"current_password":"incorrect","password":"replacement-synthetic-password","confirm":"replacement-synthetic-password"}`,
		`{"current_password":"synthetic-management-password","password":"short","confirm":"short"}`,
		`{"current_password":"synthetic-management-password","password":"replacement-synthetic-password","confirm":"different"}`,
	} {
		if w = m.request("POST", "/api/post/account/password", body, headers); w.Code != 400 {
			t.Fatal("invalid password change succeeded")
		}
		if w = m.request("GET", "/api/post/account", "", headers); w.Code != 200 {
			t.Fatal("failed edit revoked a valid session")
		}
	}
	body := `{"current_password":"synthetic-management-password","password":"` + newPassword + `","confirm":"` + newPassword + `"}`
	w = m.request("POST", "/api/post/account/password", body, headers)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if strings.Contains(w.Body.String(), newPassword) || w.Result().Cookies()[0].MaxAge >= 0 {
		t.Fatal("password response leaked or did not clear cookie")
	}
	if w = m.request("GET", "/api/post/session", "", headers); w.Code != 401 {
		t.Fatal("old browser session survived")
	}
	if w = m.bearer("GET", "/api/post/account", ""); w.Code != 401 {
		t.Fatal("old PocketBase token survived")
	}
	r, err := m.s.App.FindRecordById(core.CollectionNameSuperusers, m.admin.Id)
	if err != nil || !r.ValidatePassword(newPassword) || r.ValidatePassword("synthetic-management-password") {
		t.Fatal("new password was not committed correctly")
	}
	var count int
	_ = m.s.App.DB().NewQuery(`SELECT count(*) FROM post_sessions`).Row(&count)
	if count != 0 {
		t.Fatal("other administrator sessions were not removed")
	}
}
