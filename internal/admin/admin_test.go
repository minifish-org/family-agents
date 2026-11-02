package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/minifish-org/pith-post/internal/agent"
	"github.com/minifish-org/pith-post/internal/matrix"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

func TestManagementRequiresSuperuserAndNeverReturnsCredentials(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "admin-test")
	manager := agent.New(s, nil, nil)
	defer manager.Close()
	routes, err := apis.NewRouter(s.App)
	if err != nil {
		t.Fatal(err)
	}
	Admin{Manager: manager, Matrix: matrix.Factory{Store: s}}.Register(&core.ServeEvent{App: s.App, Router: routes})
	handler, err := routes.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	adminCollection, err := s.App.FindCollectionByNameOrId("_superusers")
	if err != nil {
		t.Fatal(err)
	}
	admin := core.NewRecord(adminCollection)
	admin.SetEmail("admin@example.test")
	admin.SetPassword("test-password-not-real-123")
	if err = s.App.Save(admin); err != nil {
		t.Fatal(err)
	}
	token, err := admin.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	userCollection := core.NewAuthCollection("family_members")
	if err = s.App.Save(userCollection); err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(userCollection)
	user.SetEmail("owner@example.test")
	user.SetPassword("test-password-not-real-456")
	if err = s.App.Save(user); err != nil {
		t.Fatal(err)
	}
	userToken, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	for _, auth := range []string{"", userToken} {
		for _, path := range []string{"/api/post/agents", "/api/post/agents/" + c.ID + "/history"} {
			response := request(http.MethodGet, path, auth, "")
			if response.Code != 401 && response.Code != 403 {
				t.Fatalf("non-administrator could access %s: %d", path, response.Code)
			}
		}
		for _, action := range []string{"start", "stop", "restart", "resume", "new-conversation", "credentials", "trigger", "cancel-run", "review", "reset-identity", "confirm-recovery-impossible", "bind-room", "discard-delivery"} {
			response := request(http.MethodPost, "/api/post/agents/"+c.ID+"/"+action, auth, "{}")
			if response.Code != 401 && response.Code != 403 {
				t.Fatalf("non-administrator could invoke %s: %d", action, response.Code)
			}
		}
	}
	secret := "test-only-model-secret-98a"
	body, _ := json.Marshal(map[string]string{"model_key": secret, "password": "test-only-bot-password"})
	response := request(http.MethodPost, "/api/post/agents/"+c.ID+"/credentials", token, string(body))
	if response.Code != 200 {
		t.Fatalf("credential entry failed: %s", response.Body.String())
	}
	for _, path := range []string{"/api/post/agents", "/api/post/agents/" + c.ID + "/history", "/api/collections/agents/records/" + c.ID} {
		response = request(http.MethodGet, path, token, "")
		if response.Code != 200 {
			t.Fatalf("administrator request failed: %s", response.Body.String())
		}
		if strings.Contains(response.Body.String(), secret) || strings.Contains(response.Body.String(), "test-only-bot-password") {
			t.Fatal("API response exposed secret values")
		}
	}
	response = request(http.MethodGet, "/api/collections/post_secrets/records", token, "")
	if response.Code != 404 {
		t.Fatal("private credential table is exposed as a collection")
	}
	response = request(http.MethodGet, "/post/", "", "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), "Pith Post") || response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("embedded admin view was not served with a content security policy")
	}
}
