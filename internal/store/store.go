// Package store keeps public configuration in PocketBase and private state in non-API tables.
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type Store struct {
	App   core.App
	Root  string
	vault cipher.AEAD
	mu    sync.Mutex
}

func New(app core.App, key string) (*Store, error) {
	raw, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(raw) != 32 {
		return nil, errors.New("PITH_POST_MASTER_KEY must be a base64-encoded 32-byte key")
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	vault, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	root := filepath.Join(app.DataDir(), "agents")
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(app.DataDir(), 0700); err != nil {
		return nil, err
	}
	return &Store{App: app, Root: root, vault: vault}, nil
}

func (s *Store) Init() error {
	for _, query := range []string{
		`CREATE TABLE IF NOT EXISTS post_inbox (agent TEXT NOT NULL, event TEXT NOT NULL, raw BLOB, handled INTEGER NOT NULL DEFAULT 0, conversation INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, PRIMARY KEY(agent,event))`,
		`CREATE TABLE IF NOT EXISTS post_state (agent TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS post_secrets (agent TEXT PRIMARY KEY, value BLOB NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS post_runs (id TEXT PRIMARY KEY, agent TEXT NOT NULL, source TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', UNIQUE(agent, source))`,
		`CREATE TABLE IF NOT EXISTS post_outbox (id TEXT PRIMARY KEY, agent TEXT NOT NULL, run TEXT NOT NULL, ordinal INTEGER NOT NULL, content TEXT NOT NULL, wire BLOB, sent INTEGER NOT NULL DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS post_runs_pending ON post_runs(agent,status,created)`,
		`CREATE INDEX IF NOT EXISTS post_outbox_pending ON post_outbox(agent,sent)`,
		`CREATE TABLE IF NOT EXISTS post_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL)`,
	} {
		if _, err := s.App.DB().NewQuery(query).Execute(); err != nil {
			return err
		}
	}
	// The process lock is held before bootstrap. Any running row belongs to a previous process.
	_, err := s.App.DB().NewQuery(`UPDATE post_runs SET status='interrupted', error='Execution interrupted; review before replay' WHERE status='running'`).Execute()
	return err
}

func (s *Store) seal(agent string, raw []byte) []byte {
	nonce := make([]byte, s.vault.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic("secure random source unavailable")
	}
	return s.vault.Seal(nonce, nonce, raw, []byte("pith-post:v1:"+agent))
}
func (s *Store) open(agent string, data []byte) ([]byte, error) {
	n := s.vault.NonceSize()
	if len(data) < n {
		return nil, errors.New("stored secrets cannot be decrypted")
	}
	raw, err := s.vault.Open(nil, data[:n], data[n:], []byte("pith-post:v1:"+agent))
	if err != nil {
		return nil, errors.New("stored secrets cannot be decrypted; restore the original master key")
	}
	return raw, nil
}
func (s *Store) Secrets(agent string) (domain.Secrets, error) {
	var row struct {
		Value []byte `db:"value"`
	}
	var result domain.Secrets
	err := s.App.DB().NewQuery(`SELECT value FROM post_secrets WHERE agent={:a}`).Bind(dbx.Params{"a": agent}).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	raw, err := s.open(agent, row.Value)
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}
func (s *Store) PutSecrets(agent string, secrets domain.Secrets) error {
	raw, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	_, err = s.App.DB().NewQuery(`INSERT INTO post_secrets(agent,value) VALUES({:a},{:v}) ON CONFLICT(agent) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"a": agent, "v": s.seal(agent, raw)}).Execute()
	return err
}
func (s *Store) State(agent string) (domain.State, error) {
	var row struct {
		Value string `db:"value"`
	}
	var state domain.State
	err := s.App.DB().NewQuery(`SELECT value FROM post_state WHERE agent={:a}`).Bind(dbx.Params{"a": agent}).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	err = json.Unmarshal([]byte(row.Value), &state)
	return state, err
}
func (s *Store) UpdateState(agent string, fn func(*domain.State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.State(agent)
	if err != nil {
		return err
	}
	if err = fn(&state); err != nil {
		return err
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = s.App.DB().NewQuery(`INSERT INTO post_state(agent,value) VALUES({:a},{:v}) ON CONFLICT(agent) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"a": agent, "v": string(raw)}).Execute()
	return err
}
func (s *Store) Config(agent string) (domain.Config, error) {
	r, err := s.App.FindRecordById("agents", agent)
	if err != nil {
		return domain.Config{}, err
	}
	return ConfigFromRecord(s.App, r)
}
func ConfigFromRecord(app core.App, r *core.Record) (domain.Config, error) {
	owner, err := app.FindRecordById("owners", r.GetString("owner"))
	if err != nil {
		return domain.Config{}, errors.New("owner record not found")
	}
	c := domain.Config{ID: r.Id, Name: r.GetString("name"), Owner: owner.GetString("mxid"), Bot: r.GetString("bot_mxid"), Homeserver: r.GetString("homeserver"), Prompt: r.GetString("system_prompt"), Model: r.GetString("model"), ModelURL: r.GetString("model_url"), ModelAPI: r.GetString("model_api"), ContextWindow: r.GetInt("context_window"), MaxTokens: r.GetInt("max_tokens"), AutoStart: r.GetBool("auto_start"), AutoReset: r.GetBool("auto_reset")}
	return c, c.Validate()
}
func (s *Store) Configs() ([]domain.Config, error) {
	records, err := s.App.FindAllRecords("agents")
	if err != nil {
		return nil, err
	}
	result := make([]domain.Config, 0, len(records))
	for _, r := range records {
		c, e := ConfigFromRecord(s.App, r)
		if e != nil {
			return nil, e
		}
		result = append(result, c)
	}
	return result, nil
}
func (s *Store) Paths(agent string, state domain.State) (workspace, session, crypto string, err error) {
	if err = domain.CheckID(agent); err != nil {
		return
	}
	dir := filepath.Join(s.Root, agent)
	workspace = filepath.Join(dir, "workspace")
	session = filepath.Join(dir, fmt.Sprintf("conversation-%d.jsonl", state.Conversation))
	crypto = filepath.Join(dir, fmt.Sprintf("crypto-%d.db", state.Generation))
	err = os.MkdirAll(workspace, 0700)
	return
}
func StableID(agent, source string) string {
	sum := sha256.Sum256([]byte(agent + "\x00" + source))
	return hex.EncodeToString(sum[:])
}

type Run struct {
	ID      string `db:"id" json:"id"`
	Agent   string `db:"agent" json:"agent"`
	Source  string `db:"source" json:"source"`
	Input   string `db:"input" json:"input"`
	Status  string `db:"status" json:"status"`
	Created int64  `db:"created" json:"created"`
	Error   string `db:"error" json:"error"`
}
type Outbox struct {
	ID      string `db:"id" json:"id"`
	Agent   string `db:"agent" json:"agent"`
	Run     string `db:"run" json:"run"`
	Ordinal int    `db:"ordinal" json:"ordinal"`
	Content string `db:"content" json:"content"`
	Wire    []byte `db:"wire" json:"-"`
	Sent    bool   `db:"sent" json:"sent"`
}

func (s *Store) Enqueue(agent, source, input string) (string, error) {
	id := StableID(agent, source)
	_, err := s.App.DB().NewQuery(`INSERT INTO post_runs(id,agent,source,input,status,created) VALUES({:id},{:a},{:s},{:i},'queued',{:t}) ON CONFLICT(agent,source) DO NOTHING`).Bind(dbx.Params{"id": id, "a": agent, "s": source, "i": input, "t": time.Now().UnixMilli()}).Execute()
	return id, err
}

// RecoverAgent is called only while no worker for this agent exists.
func (s *Store) RecoverAgent(agent string) error {
	_, err := s.App.DB().NewQuery(`UPDATE post_runs SET status='interrupted',error='Execution interrupted; review before replay' WHERE agent={:a} AND status='running'`).Bind(dbx.Params{"a": agent}).Execute()
	return err
}

func (s *Store) Next(agent string) (*Run, error) {
	var r Run
	err := s.App.DB().NewQuery(`SELECT * FROM post_runs WHERE agent={:a} AND status='queued' ORDER BY created,rowid LIMIT 1`).Bind(dbx.Params{"a": agent}).One(&r)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &r, err
}
func (s *Store) SetRun(id, status, reason string) error {
	_, err := s.App.DB().NewQuery(`UPDATE post_runs SET status={:s},error={:e} WHERE id={:id}`).Bind(dbx.Params{"id": id, "s": status, "e": reason}).Execute()
	return err
}
func (s *Store) HasReview(agent string) (bool, error) {
	var count int
	err := s.App.DB().NewQuery(`SELECT count(*) FROM post_runs WHERE agent={:a} AND status='interrupted'`).Bind(dbx.Params{"a": agent}).Row(&count)
	return count > 0, err
}

// HasBlockedRun also catches a completion whose failure could not be persisted.
func (s *Store) HasBlockedRun(agent string) (bool, error) {
	var count int
	err := s.App.DB().NewQuery(`SELECT count(*) FROM post_runs WHERE agent={:a} AND status IN ('running','interrupted')`).Bind(dbx.Params{"a": agent}).Row(&count)
	return count > 0, err
}

func (s *Store) Unsettled(agent string) (bool, error) {
	var count int
	err := s.App.DB().NewQuery(`SELECT (SELECT count(*) FROM post_runs WHERE agent={:a} AND status IN ('queued','running','interrupted')) + (SELECT count(*) FROM post_outbox WHERE agent={:a} AND sent=0)`).Bind(dbx.Params{"a": agent}).Row(&count)
	return count > 0, err
}

// Complete atomically records the completed run and every reply before any delivery.
func (s *Store) Complete(r *Run, contents []domain.Content) error {
	if len(contents) == 0 || len(contents) > 8 {
		return errors.New("a run must produce 1 to 8 content items")
	}
	for _, c := range contents {
		if err := c.Validate(); err != nil {
			return err
		}
	}
	return s.App.RunInTransaction(func(app core.App) error {
		for i, c := range contents {
			raw, err := json.Marshal(c)
			if err != nil {
				return err
			}
			_, err = app.DB().NewQuery(`INSERT INTO post_outbox(id,agent,run,ordinal,content) VALUES({:id},{:a},{:r},{:i},{:c})`).Bind(dbx.Params{"id": StableID(r.ID, fmt.Sprint(i)), "a": r.Agent, "r": r.ID, "i": i, "c": string(raw)}).Execute()
			if err != nil {
				return err
			}
		}
		_, err := app.DB().NewQuery(`UPDATE post_runs SET status='completed',error='' WHERE id={:id}`).Bind(dbx.Params{"id": r.ID}).Execute()
		return err
	})
}
func (s *Store) Pending(agent string) ([]Outbox, error) {
	rows := []Outbox{}
	err := s.App.DB().NewQuery(`SELECT o.* FROM post_outbox o JOIN post_runs r ON o.run=r.id WHERE o.agent={:a} AND o.sent=0 ORDER BY r.created,r.rowid,o.ordinal LIMIT 64`).Bind(dbx.Params{"a": agent}).All(&rows)
	return rows, err
}
func (s *Store) Wire(id string, wire []byte) error {
	_, err := s.App.DB().NewQuery(`UPDATE post_outbox SET wire={:w} WHERE id={:id}`).Bind(dbx.Params{"id": id, "w": wire}).Execute()
	return err
}
func (s *Store) Sent(id string) error {
	_, err := s.App.DB().NewQuery(`UPDATE post_outbox SET sent=1 WHERE id={:id}`).Bind(dbx.Params{"id": id}).Execute()
	return err
}
func (s *Store) History(agent string) ([]Run, []Outbox, error) {
	runs := []Run{}
	out := []Outbox{}
	err := s.App.DB().NewQuery(`SELECT * FROM post_runs WHERE agent={:a} ORDER BY created DESC,rowid DESC LIMIT 100`).Bind(dbx.Params{"a": agent}).All(&runs)
	if err != nil {
		return nil, nil, err
	}
	err = s.App.DB().NewQuery(`SELECT id,agent,run,ordinal,content,sent FROM post_outbox WHERE agent={:a} ORDER BY rowid DESC LIMIT 100`).Bind(dbx.Params{"a": agent}).All(&out)
	return runs, out, err
}
func (s *Store) Review(agent, id string, replay bool) error {
	status := "reviewed"
	if replay {
		status = "queued"
	}
	result, err := s.App.DB().NewQuery(`UPDATE post_runs SET status={:s},error='Administrator reviewed interrupted execution' WHERE agent={:a} AND id={:id} AND status='interrupted'`).Bind(dbx.Params{"a": agent, "id": id, "s": status}).Execute()
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("interrupted run not found")
	}
	return nil
}
func (s *Store) CancelRun(agent, id string) error {
	result, err := s.App.DB().NewQuery(`UPDATE post_runs SET status='canceled',error='Administrator canceled queued execution' WHERE agent={:a} AND id={:id} AND status='queued'`).Bind(dbx.Params{"a": agent, "id": id}).Execute()
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("queued run not found")
	}
	return nil
}

func (s *Store) Audit(agent, action, reason string) error {
	_, err := s.App.DB().NewQuery(`INSERT INTO post_audit(agent,action,reason,created) VALUES({:a},{:x},{:r},{:t})`).Bind(dbx.Params{"a": agent, "x": action, "r": reason, "t": time.Now().UnixMilli()}).Execute()
	return err
}
