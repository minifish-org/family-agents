package matrix

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/dbx"
)

func TestMatrixProfileUsesOriginalAccountAndSynchronizesNameAndImage(t *testing.T) {
	s := testutil.Store(t)
	c := testutil.Agent(t, s, "profile")
	before, _ := s.State(c.ID)
	secret := domain.Secrets{AccessToken: "synthetic-profile-token", PickleKey: []byte("original-test-pickle")}
	_ = s.PutSecrets(c.ID, secret)
	var mu sync.Mutex
	name, avatarURI := "", ""
	var uploaded []byte
	calls := 0
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		w.Header().Set("Content-Type", "application/json")
		reply := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		if r.Header.Get("Authorization") != "Bearer "+secret.AccessToken {
			t.Error("profile token changed")
		}
		if fail {
			w.WriteHeader(503)
			reply(map[string]string{"error": "unavailable"})
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/account/whoami"):
			reply(map[string]string{"user_id": c.Bot, "device_id": before.Device})
		case strings.HasSuffix(r.URL.Path, "/displayname"):
			var body struct {
				Name string `json:"displayname"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			name = body.Name
			reply(map[string]any{})
		case strings.HasSuffix(r.URL.Path, "/avatar_url"):
			var body struct {
				URL string `json:"avatar_url"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			avatarURI = body.URL
			reply(map[string]any{})
		case strings.HasSuffix(r.URL.Path, "/upload"):
			uploaded, _ = io.ReadAll(r.Body)
			if r.Header.Get("Content-Type") != "image/png" {
				t.Error("wrong avatar media type")
			}
			reply(map[string]string{"content_uri": "mxc://example.test/avatar"})
		default:
			t.Errorf("unexpected profile request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	// Test-only fixture routing; production identity edits remain forbidden.
	_, _ = s.App.DB().NewQuery(`UPDATE agents SET homeserver={:url} WHERE id={:id}`).Bind(dbx.Params{"url": server.URL, "id": c.ID}).Execute()
	var picture bytes.Buffer
	_ = png.Encode(&picture, image.NewNRGBA(image.Rect(0, 0, 256, 256)))
	if err := s.SaveAvatar(c.ID, picture.Bytes()); err != nil {
		t.Fatal(err)
	}
	f := Factory{Store: s}
	if err := f.SyncProfile(context.Background(), c.ID); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if name != c.Name || avatarURI != "mxc://example.test/avatar" || !bytes.Equal(uploaded, picture.Bytes()) {
		t.Fatal("name/image did not reach Matrix")
	}
	firstCalls := calls
	mu.Unlock()
	if err := f.SyncProfile(context.Background(), c.ID); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if calls != firstCalls {
		t.Fatal("unchanged profile caused repeated network writes")
	}
	mu.Unlock()
	after, _ := s.State(c.ID)
	afterSecret, _ := s.Secrets(c.ID)
	if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(secret, afterSecret) {
		t.Fatal("profile update changed crypto identity")
	}
	_ = s.SaveAvatar(c.ID, nil)
	if err := f.SyncProfile(context.Background(), c.ID); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if avatarURI != "" {
		t.Fatal("avatar removal was not synchronized")
	}
	fail = true
	mu.Unlock()
	r, _ := s.App.FindRecordById("agents", c.ID)
	r.Set("name", "New profile name")
	_ = s.App.Save(r)
	if err := f.SyncProfile(context.Background(), c.ID); err == nil {
		t.Fatal("provider failure reported as success")
	}
	p, _ := s.Profile(c.ID)
	if p.AppliedName == "New profile name" || p.Error == "" {
		t.Fatal("failed profile update was marked applied")
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	if err := f.SyncProfile(context.Background(), c.ID); err != nil {
		t.Fatal("saved profile could not be retried", err)
	}
}
