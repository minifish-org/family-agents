package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type Connection struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	Model     string `json:"model"`
	API       string `json:"api"`
	Context   int    `json:"context_window"`
	MaxTokens int    `json:"max_tokens"`
	KeySet    bool   `json:"key_set"`
	Provider  string `json:"provider,omitempty"`
	Thinking  string `json:"thinking,omitempty"`
	Auth      string `json:"auth,omitempty"`
}

func (c Connection) Apply(config *domain.Config) {
	config.Model, config.ModelURL, config.ModelAPI = c.Model, c.URL, c.API
	config.ContextWindow, config.MaxTokens = c.Context, c.MaxTokens
	config.ModelProvider, config.Thinking = c.Provider, c.Thinking
	config.ModelAuth = c.Auth
}

func (c Connection) Validate() error {
	if err := domain.CheckID(c.ID); err != nil {
		return err
	}
	if strings.TrimSpace(c.Name) == "" || len(c.Name) > 100 {
		return errors.New("a connection name of 1 to 100 bytes is required")
	}
	if !domain.ValidURL(c.URL) || len(c.URL) > 2048 {
		return errors.New("use an HTTP(S) service URL without credentials, query, or fragment")
	}
	if strings.TrimSpace(c.Model) == "" || len(c.Model) > 255 {
		return errors.New("a model ID is required")
	}
	if !domain.ValidModelAPI(c.API) {
		return errors.New("choose a supported API format")
	}
	if c.MaxTokens < 1 || c.Context < c.MaxTokens {
		return errors.New("the positive reply limit must fit in the context window")
	}
	return nil
}

func readConnection(app core.App, id string) (Connection, error) {
	var row struct {
		Value string `db:"value"`
	}
	var c Connection
	err := app.DB().NewQuery(`SELECT value FROM post_connections WHERE id={:id}`).Bind(dbx.Params{"id": id}).One(&row)
	if err == nil {
		err = json.Unmarshal([]byte(row.Value), &c)
	}
	return c, err
}
func (s *Store) Connection(id string) (Connection, error) { return readConnection(s.App, id) }
func (s *Store) ConnectionKey(id string) (string, error) {
	var row struct {
		Secret []byte `db:"secret"`
	}
	if err := s.App.DB().NewQuery(`SELECT secret FROM post_connections WHERE id={:id}`).Bind(dbx.Params{"id": id}).One(&row); err != nil {
		return "", err
	}
	raw, err := s.open("connection:"+id, row.Secret)
	return string(raw), err
}
func (s *Store) Connections() ([]Connection, error) {
	var rows []struct {
		Value string `db:"value"`
	}
	if err := s.App.DB().NewQuery(`SELECT value FROM post_connections ORDER BY rowid`).All(&rows); err != nil {
		return nil, err
	}
	result := make([]Connection, 0, len(rows))
	for _, row := range rows {
		var c Connection
		if err := json.Unmarshal([]byte(row.Value), &c); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, nil
}
func (s *Store) SaveConnection(c Connection, key *string) error {
	if err := c.Validate(); err != nil {
		return err
	}
	return s.App.RunInTransaction(func(app core.App) error {
		tx := s.WithApp(app)
		value := ""
		if _, err := tx.Connection(c.ID); err == nil {
			var e error
			value, e = tx.ConnectionKey(c.ID)
			if e != nil {
				return e
			}
		}
		if key != nil {
			value = *key
		}
		if len(value) > 16384 {
			return errors.New("API key is too long")
		}
		c.KeySet = value != ""
		raw, err := json.Marshal(c)
		if err != nil {
			return err
		}
		_, err = app.DB().NewQuery(`INSERT INTO post_connections(id,value,secret) VALUES({:id},{:v},{:s}) ON CONFLICT(id) DO UPDATE SET value=excluded.value,secret=excluded.secret`).Bind(dbx.Params{"id": c.ID, "v": string(raw), "s": s.seal("connection:"+c.ID, []byte(value))}).Execute()
		return err
	})
}

// WithApp keeps the vault but makes all database operations use the supplied transaction.
func (s *Store) WithApp(app core.App) *Store { return &Store{App: app, Root: s.Root, vault: s.vault} }

// GenerationConfig snapshots the shared configuration and key together between turns.
func (s *Store) GenerationConfig(id string) (domain.Config, string, error) {
	var c domain.Config
	var key string
	err := s.App.RunInTransaction(func(app core.App) error {
		tx := s.WithApp(app)
		var err error
		c, err = tx.Config(id)
		if err != nil {
			return err
		}
		if c.Connection != "" {
			key, err = tx.ConnectionKey(c.Connection)
			return err
		}
		secrets, err := tx.Secrets(id)
		key = secrets.ModelKey
		return err
	})
	return c, key, err
}

// Existing assistants retain their identity and model settings. Secrets never leave the vault.
func (s *Store) MigrateConnections() error {
	return s.App.RunInTransaction(func(app core.App) error {
		records, err := app.FindAllRecords("agents")
		if err != nil {
			return err
		}
		tx := s.WithApp(app)
		for _, r := range records {
			if r.GetString("model_connection") != "" {
				continue
			}
			c, err := ConfigFromRecord(app, r)
			if err != nil {
				return err
			}
			secrets, err := tx.Secrets(c.ID)
			if err != nil {
				return err
			}
			connection := Connection{ID: "model-" + c.ID, Name: c.Name + " model", URL: c.ModelURL, Model: c.Model, API: c.ModelAPI, Context: c.ContextWindow, MaxTokens: c.MaxTokens}
			if len(connection.Name) > 100 {
				connection.Name = "Existing model"
			}
			if err = tx.SaveConnection(connection, &secrets.ModelKey); err != nil {
				return err
			}
			r.Set("model_connection", connection.ID)
			if err = app.Save(r); err != nil {
				return err
			}
		}
		return nil
	})
}

type Counts struct {
	Queued      int `db:"queued" json:"queued"`
	Running     int `db:"running" json:"running"`
	Interrupted int `db:"interrupted" json:"interrupted"`
	Pending     int `db:"pending" json:"pending"`
}

func (s *Store) Counts(id string) (Counts, error) {
	var result Counts
	err := s.App.DB().NewQuery(`SELECT (SELECT count(*) FROM post_runs WHERE agent={:a} AND status='queued') AS queued,(SELECT count(*) FROM post_runs WHERE agent={:a} AND status='running') AS running,(SELECT count(*) FROM post_runs WHERE agent={:a} AND status='interrupted') AS interrupted,(SELECT count(*) FROM post_outbox WHERE agent={:a} AND sent=0) AS pending`).Bind(dbx.Params{"a": id}).One(&result)
	return result, err
}

// A selected global model applies to every agent without rewriting their identities or legacy settings.
func GlobalConnection(app core.App) (string, error) {
	var raw string
	err := app.DB().NewQuery(`SELECT value FROM post_settings WHERE name='model'`).Row(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var selected struct {
		Connection string `json:"connection"`
	}
	if err = json.Unmarshal([]byte(raw), &selected); err != nil {
		return "", err
	}
	return selected.Connection, nil
}
func (s *Store) SelectGlobalConnection(id string) error {
	if _, err := s.Connection(id); err != nil {
		return err
	}
	raw, _ := json.Marshal(map[string]string{"connection": id})
	_, err := s.App.DB().NewQuery(`INSERT INTO post_settings(name,value) VALUES('model',{:v}) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"v": string(raw)}).Execute()
	return err
}
