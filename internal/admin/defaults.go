package admin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type SetupDefaults struct {
	Homeserver string `json:"homeserver"`
	Connection string `json:"connection"`
}

func setupDefaults(app core.App) (SetupDefaults, error) {
	var defaults SetupDefaults
	var raw string
	if err := app.DB().NewQuery(`SELECT value FROM post_settings WHERE name='setup'`).Row(&raw); err == nil {
		if err = json.Unmarshal([]byte(raw), &defaults); err != nil {
			return defaults, err
		}
	}
	// Adopt an existing deployment's common server, without changing any agent's identity.
	if defaults.Homeserver == "" {
		var servers []struct {
			URL string `db:"homeserver"`
		}
		if err := app.DB().NewQuery(`SELECT DISTINCT homeserver FROM agents ORDER BY homeserver`).All(&servers); err != nil {
			return defaults, err
		}
		if len(servers) == 1 {
			defaults.Homeserver = servers[0].URL
		}
	}
	var connections []struct {
		ID string `db:"id"`
	}
	if err := app.DB().NewQuery(`SELECT id FROM post_connections ORDER BY rowid`).All(&connections); err != nil {
		return defaults, err
	}
	valid := false
	for _, c := range connections {
		if c.ID == defaults.Connection {
			valid = true
		}
	}
	if !valid {
		defaults.Connection = ""
		if len(connections) > 0 {
			defaults.Connection = connections[0].ID
		}
	}
	return defaults, nil
}
func putDefaults(app core.App, defaults SetupDefaults) error {
	if defaults.Homeserver != "" && (!domain.ValidURL(defaults.Homeserver) || len(defaults.Homeserver) > 2048) {
		return errors.New("use an HTTP(S) Matrix server address without embedded credentials")
	}
	if defaults.Connection != "" {
		var count int
		if err := app.DB().NewQuery(`SELECT count(*) FROM post_connections WHERE id={:id}`).Bind(dbx.Params{"id": defaults.Connection}).Row(&count); err != nil || count != 1 {
			return errors.New("choose an existing model")
		}
	}
	raw, err := json.Marshal(defaults)
	if err != nil {
		return err
	}
	_, err = app.DB().NewQuery(`INSERT INTO post_settings(name,value) VALUES('setup',{:v}) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"v": string(raw)}).Execute()
	return err
}
func (a Admin) getDefaults(e *core.RequestEvent) error {
	defaults, err := setupDefaults(e.App)
	if err != nil {
		return e.InternalServerError("Shared settings could not be loaded.", nil)
	}
	return e.JSON(200, defaults)
}

// Server changes never retarget existing people or Matrix identities.
func serverChangeAllowed(app core.App, next string) (SetupDefaults, error) {
	current, err := setupDefaults(app)
	if err != nil {
		return current, err
	}
	if next != strings.TrimRight(current.Homeserver, "/") {
		var count int
		if err := app.DB().NewQuery(`SELECT (SELECT count(*) FROM owners) + (SELECT count(*) FROM agents)`).Row(&count); err != nil {
			return current, err
		}
		if count != 0 {
			return current, errors.New("Remove all agents and people before changing the Matrix server.")
		}
	}
	return current, nil
}

// Probe the public Matrix client endpoint without sending credentials or following redirects.
func checkMatrixServer(ctx context.Context, address string) error {
	if !domain.ValidURL(address) || len(address) > 2048 {
		return errors.New("Enter an HTTP(S) Matrix server address without credentials, a query or a fragment.")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address+"/_matrix/client/versions", nil)
	if err != nil {
		return errors.New("Check the Matrix server address.")
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return errors.New("Could not reach this Matrix server. Check the address and try again.")
	}
	defer response.Body.Close()
	var versions struct {
		Versions []string `json:"versions"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&versions) != nil || len(versions.Versions) == 0 {
		return errors.New("This address did not return a valid Matrix client connection. Check the server address.")
	}
	return nil
}

func (a Admin) checkServer(e *core.RequestEvent) error {
	var in struct {
		Homeserver string `json:"homeserver"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	if err := checkMatrixServer(e.Request.Context(), strings.TrimRight(strings.TrimSpace(in.Homeserver), "/")); err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}

func (a Admin) saveDefaults(e *core.RequestEvent) error {
	var defaults SetupDefaults
	if err := decode(e, &defaults); err != nil {
		return err
	}
	defaults.Homeserver = strings.TrimRight(strings.TrimSpace(defaults.Homeserver), "/")
	if defaults.Homeserver == "" {
		return e.BadRequestError("Enter a Matrix server address.", nil)
	}
	current, err := serverChangeAllowed(e.App, defaults.Homeserver)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	if defaults.Homeserver != strings.TrimRight(current.Homeserver, "/") {
		if err := checkMatrixServer(e.Request.Context(), defaults.Homeserver); err != nil {
			return e.BadRequestError(err.Error(), nil)
		}
	}
	// Recheck inside the write transaction: a person may have been added during the probe.
	if err := e.App.RunInTransaction(func(app core.App) error {
		current, err := serverChangeAllowed(app, defaults.Homeserver)
		if err != nil {
			return err
		}
		if defaults.Connection == "" {
			defaults.Connection = current.Connection
		}
		return putDefaults(app, defaults)
	}); err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
