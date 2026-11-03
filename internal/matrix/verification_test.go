package matrix

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/testutil"
	"github.com/pocketbase/dbx"
)

func TestBotDeviceSelfSigningPersistsSeedsAndNeverReplacesIdentity(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new-identity", true: "existing-identity"}[existing], func(t *testing.T) {
			s := testutil.Store(t)
			c := testutil.Agent(t, s, "verify-device")
			before, _ := s.State(c.ID)
			initial := domain.Secrets{Password: "synthetic-bot-password", AccessToken: "offline-token"}
			_ = s.PutSecrets(c.ID, initial)
			base := &matrixServer{c: c, device: before.Device, events: map[string][]byte{}}
			var mu sync.Mutex
			var master, self, user map[string]any
			publishes, signs := 0, 0
			if existing {
				master = map[string]any{"user_id": c.Bot, "usage": []string{"master"}, "keys": map[string]string{"ed25519:external": "external"}}
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/keys/query") {
					mu.Lock()
					defer mu.Unlock()
					base.mu.Lock()
					raw := append(json.RawMessage(nil), base.keys...)
					base.mu.Unlock()
					devices := map[string]json.RawMessage{}
					if len(raw) > 0 {
						devices[before.Device] = raw
					}
					out := map[string]any{"device_keys": map[string]any{c.Bot: devices}, "failures": map[string]any{}}
					if master != nil {
						out["master_keys"] = map[string]any{c.Bot: master}
					}
					if self != nil {
						out["self_signing_keys"] = map[string]any{c.Bot: self}
					}
					if user != nil {
						out["user_signing_keys"] = map[string]any{c.Bot: user}
					}
					_ = json.NewEncoder(w).Encode(out)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/keys/device_signing/upload") {
					mu.Lock()
					defer mu.Unlock()
					saved, _ := s.Secrets(c.ID)
					if len(saved.CrossSigning) == 0 {
						t.Error("private signing keys were not persisted before publication")
					}
					var body map[string]map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					master, self, user = body["master_key"], body["self_signing_key"], body["user_signing_key"]
					publishes++
					_ = json.NewEncoder(w).Encode(map[string]any{})
					return
				}
				if strings.HasSuffix(r.URL.Path, "/keys/signatures/upload") {
					mu.Lock()
					defer mu.Unlock()
					var body map[string]map[string]map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if signed, ok := body[c.Bot][before.Device]; ok {
						base.mu.Lock()
						var original map[string]any
						_ = json.Unmarshal(base.keys, &original)
						signatures := original["signatures"].(map[string]any)
						incoming := signed["signatures"].(map[string]any)[c.Bot].(map[string]any)
						for k, v := range incoming {
							signatures[c.Bot].(map[string]any)[k] = v
						}
						base.keys, _ = json.Marshal(original)
						base.mu.Unlock()
						signs++
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"failures": map[string]any{}})
					return
				}
				base.ServeHTTP(w, r)
			}))
			defer server.Close()
			c.Homeserver = server.URL
			f := Factory{Store: s}
			opened, err := f.Open(context.Background(), c)
			if err != nil {
				t.Fatal(err)
			}
			tr := opened.(*Transport)
			identity := tr.helper.Machine().OwnIdentity()
			err = tr.verifyOwnDevice(context.Background())
			if existing {
				if err == nil {
					t.Fatal("replaced an existing identity without private keys")
				}
				mu.Lock()
				if publishes != 0 || signs != 0 {
					t.Fatal("existing cross-signing identity was overwritten")
				}
				mu.Unlock()
				secret, _ := s.Secrets(c.ID)
				if len(secret.CrossSigning) != 0 {
					t.Fatal("unexpected replacement key generation")
				}
				_ = tr.Close()
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			state, _ := s.State(c.ID)
			if !state.DeviceVerified || state.Device != before.Device || state.Room != before.Room || state.Generation != before.Generation {
				t.Fatal("device verification changed the original identity")
			}
			secret, _ := s.Secrets(c.ID)
			if len(secret.CrossSigning) == 0 || secret.Password != initial.Password || secret.AccessToken != initial.AccessToken {
				t.Fatal("cross-signing keys or original credentials lost")
			}
			var encrypted []byte
			_ = s.App.DB().NewQuery(`SELECT value FROM post_secrets WHERE agent={:id}`).Bind(dbx.Params{"id": c.ID}).Row(&encrypted)
			if bytes.Contains(encrypted, secret.CrossSigning) {
				t.Fatal("private cross-signing keys were stored as plaintext")
			}
			_ = tr.Close()
			opened, err = f.Open(context.Background(), c)
			if err != nil {
				t.Fatal(err)
			}
			tr = opened.(*Transport)
			defer tr.Close()
			if err = tr.verifyOwnDevice(context.Background()); err != nil {
				t.Fatal(err)
			}
			after := tr.helper.Machine().OwnIdentity()
			if after.DeviceID != identity.DeviceID || after.SigningKey != identity.SigningKey || after.IdentityKey != identity.IdentityKey {
				t.Fatal("restart recreated the device")
			}
			mu.Lock()
			if publishes != 1 || signs != 1 {
				t.Fatalf("restart recreated signatures: %d %d", publishes, signs)
			}
			// A changed public identity cannot cause our persisted private keys to be replaced.
			master["keys"] = map[string]string{"ed25519:different": "different"}
			mu.Unlock()
			if err = tr.verifyOwnDevice(context.Background()); err == nil {
				t.Fatal("changed server identity silently accepted")
			}
			restored, _ := s.Secrets(c.ID)
			if !bytes.Equal(secret.CrossSigning, restored.CrossSigning) {
				t.Fatal("private signing keys changed after a mismatch")
			}
		})
	}
}
