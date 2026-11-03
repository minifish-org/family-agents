package admin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type assistantInput struct {
	RequestID  string `json:"request_id"`
	Name       string `json:"name"`
	Prompt     string `json:"prompt"`
	OwnerID    string `json:"owner_id"`
	OwnerName  string `json:"owner_name"`
	OwnerMXID  string `json:"owner_mxid"`
	Bot        string `json:"bot"`
	Homeserver string `json:"homeserver"`
	Connection string `json:"connection"`
	Password   string `json:"password"`
	Revision   string `json:"revision"`
}

func revision(c domain.Config) string {
	c.OwnerName = ""
	raw, _ := json.Marshal(c)
	return digest(string(raw))
}
func (a Admin) createAssistant(e *core.RequestEvent) error {
	var in assistantInput
	if err := decode(e, &in); err != nil {
		return err
	}
	defaults, err := setupDefaults(e.App)
	if err != nil {
		return e.InternalServerError("Shared settings could not be loaded.", nil)
	}
	if in.Homeserver != "" && defaults.Homeserver != "" && strings.TrimRight(in.Homeserver, "/") != strings.TrimRight(defaults.Homeserver, "/") {
		return e.BadRequestError("All agents use the configured Matrix server.", nil)
	}
	in.Prompt = strings.TrimSpace(in.Prompt)
	if in.Prompt == "" {
		in.Prompt = defaultPersona
	}
	if in.Homeserver == "" {
		in.Homeserver = defaults.Homeserver
	}
	if in.Connection == "" {
		in.Connection = defaults.Connection
	}
	if strings.TrimSpace(in.OwnerName) == "" && domain.ValidMXID(in.OwnerMXID) {
		in.OwnerName = strings.SplitN(strings.TrimPrefix(in.OwnerMXID, "@"), ":", 2)[0]
	}
	if domain.CheckID(in.RequestID) != nil {
		return e.BadRequestError("A stable setup request ID is required.", nil)
	}
	if strings.TrimSpace(in.Name) == "" || utf8.RuneCountInString(strings.TrimSpace(in.Name)) > 100 || strings.TrimSpace(in.Prompt) == "" || len(in.Prompt) > 64000 {
		return e.BadRequestError("Add a name and instructions within the displayed limits.", nil)
	}
	if !domain.ValidMXID(in.Bot) || !domain.ValidURL(in.Homeserver) || len(in.Homeserver) > 2048 {
		return e.BadRequestError("Enter a full assistant Matrix ID and an HTTP(S) homeserver URL.", nil)
	}
	if in.Password == "" || len(in.Password) > 16384 {
		return e.BadRequestError("Enter the dedicated Matrix account password.", nil)
	}
	var id string
	err = e.App.RunInTransaction(func(app core.App) error {
		var existing string
		if err := app.DB().NewQuery(`SELECT agent FROM post_setup_requests WHERE admin={:a} AND request={:r}`).Bind(dbx.Params{"a": e.Auth.Id, "r": in.RequestID}).Row(&existing); err == nil {
			if _, err = app.FindRecordById("agents", existing); err != nil {
				return errors.New("setup was removed")
			}
			id = existing
			return nil
		}
		tx := a.Manager.Store.WithApp(app)
		connection, err := tx.Connection(in.Connection)
		if err != nil {
			return errors.New("model connection not found")
		}
		var owner *core.Record
		if in.OwnerID != "" {
			owner, err = app.FindRecordById("owners", in.OwnerID)
			if err != nil {
				return err
			}
		} else {
			if !domain.ValidMXID(in.OwnerMXID) || strings.TrimSpace(in.OwnerName) == "" || utf8.RuneCountInString(strings.TrimSpace(in.OwnerName)) > 100 {
				return errors.New("a person's name and full Matrix ID are required")
			}
			owner, err = app.FindFirstRecordByData("owners", "mxid", in.OwnerMXID)
			if err != nil {
				col, e := app.FindCollectionByNameOrId("owners")
				if e != nil {
					return e
				}
				owner = core.NewRecord(col)
				owner.Set("name", strings.TrimSpace(in.OwnerName))
				owner.Set("mxid", in.OwnerMXID)
				if err = app.Save(owner); err != nil {
					return err
				}
			}
		}
		if owner.GetString("mxid") == in.Bot {
			return errors.New("the assistant needs a different account from its person")
		}
		col, err := app.FindCollectionByNameOrId("agents")
		if err != nil {
			return err
		}
		r := core.NewRecord(col)
		for k, v := range map[string]any{"name": strings.TrimSpace(in.Name), "owner": owner.Id, "bot_mxid": in.Bot, "homeserver": in.Homeserver, "system_prompt": in.Prompt, "model": connection.Model, "model_url": connection.URL, "model_api": connection.API, "context_window": connection.Context, "max_tokens": connection.MaxTokens, "model_connection": connection.ID, "auto_start": false, "auto_reset": false} {
			r.Set(k, v)
		}
		if err = app.Save(r); err != nil {
			return err
		}
		if err = tx.PutSecrets(r.Id, domain.Secrets{Password: in.Password}); err != nil {
			return err
		}
		// Save the first server once; later assistants inherit it unless explicitly overridden.
		if defaults.Homeserver == "" {
			defaults.Homeserver = in.Homeserver
			defaults.Connection = connection.ID
			if err = putDefaults(app, defaults); err != nil {
				return err
			}
		}
		_, err = app.DB().NewQuery(`INSERT INTO post_setup_requests(admin,request,agent) VALUES({:a},{:r},{:id})`).Bind(dbx.Params{"a": e.Auth.Id, "r": in.RequestID, "id": r.Id}).Execute()
		if err != nil {
			return err
		}
		id = r.Id
		return tx.Audit(id, "create", "Assistant saved, awaiting explicit connection")
	})
	if err != nil {
		return e.BadRequestError("Could not create the assistant. Check the person, model connection, and unique Matrix account; your setup is kept.", nil)
	}
	saved, err := a.Manager.Store.Config(id)
	if err != nil {
		return e.InternalServerError("Agent saved, but its configuration could not be loaded. Retry with the same form.", nil)
	}
	return e.JSON(200, map[string]string{"id": id, "name": saved.Name, "prompt": saved.Prompt, "appearance_revision": appearanceRevision(saved), "persona_revision": personaRevision(saved)})
}
func (a Admin) updateAssistant(e *core.RequestEvent) error {
	var in struct {
		Name       string `json:"name"`
		Prompt     string `json:"prompt"`
		Connection string `json:"connection"`
		Revision   string `json:"revision"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Name) == "" || utf8.RuneCountInString(strings.TrimSpace(in.Name)) > 100 || strings.TrimSpace(in.Prompt) == "" || len(in.Prompt) > 64000 {
		return e.BadRequestError("Add a name and instructions within the displayed limits.", nil)
	}
	conflict := false
	err := e.App.RunInTransaction(func(app core.App) error {
		tx := a.Manager.Store.WithApp(app)
		c, err := tx.Config(e.Request.PathValue("id"))
		if err != nil {
			return err
		}
		if in.Revision != revision(c) {
			conflict = true
			return errors.New("configuration changed")
		}
		connection, err := tx.Connection(in.Connection)
		if err != nil {
			return err
		}
		r, err := app.FindRecordById("agents", c.ID)
		if err != nil {
			return err
		}
		for k, v := range map[string]any{"name": strings.TrimSpace(in.Name), "system_prompt": in.Prompt, "model_connection": connection.ID, "model": connection.Model, "model_url": connection.URL, "model_api": connection.API, "context_window": connection.Context, "max_tokens": connection.MaxTokens} {
			r.Set(k, v)
		}
		if err = app.Save(r); err != nil {
			return err
		}
		return tx.Audit(c.ID, "edit", "Assistant instructions and model updated")
	})
	if conflict {
		return e.JSON(409, map[string]string{"message": "Settings changed while you were editing. Reload the latest settings before saving."})
	}
	if err != nil {
		return e.BadRequestError("Could not save assistant settings. Check the model connection.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
func (a Admin) deleteAssistant(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	err := a.Manager.StopAndApply(id, func() error {
		return e.App.RunInTransaction(func(app core.App) error {
			r, err := app.FindRecordById("agents", id)
			if err != nil {
				return err
			}
			if err := a.Manager.Store.WithApp(app).Audit(id, "remove", "Agent stopped and configuration removed; unfinished work and private archives retained without replay"); err != nil {
				return err
			}
			return app.Delete(r)
		})
	})
	if err != nil {
		return e.BadRequestError("Could not remove this agent. Its account and private archives are kept.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
func (a Admin) owners(e *core.RequestEvent) error {
	records, err := e.App.FindAllRecords("owners")
	if err != nil {
		return e.InternalServerError("People could not be loaded.", nil)
	}
	result := []map[string]string{}
	for _, r := range records {
		a.refreshPersonSoon(r.Id)
		avatar, err := a.Manager.Store.PersonAvatar(r.Id)
		if err != nil {
			return e.InternalServerError("People could not be loaded.", nil)
		}
		result = append(result, map[string]string{"id": r.Id, "name": r.GetString("name"), "mxid": r.GetString("mxid"), "avatar": avatar.Hash})
	}
	return e.JSON(200, result)
}
func (a Admin) listConnections(e *core.RequestEvent) error {
	connections, err := a.Manager.Store.Connections()
	if err != nil {
		return e.InternalServerError("Connections could not be loaded.", nil)
	}
	return e.JSON(200, connections)
}
func (a Admin) saveConnection(e *core.RequestEvent) error {
	var in struct {
		store.Connection
		Key *string `json:"key"`
	}
	if err := decode(e, &in); err != nil {
		return err
	}
	id := e.Request.PathValue("id")
	if id == "" {
		id = randomID()
	} else if _, err := a.Manager.Store.Connection(id); err != nil {
		return e.NotFoundError("Connection not found.", nil)
	}
	in.ID = id
	if strings.TrimSpace(in.Name) == "" {
		in.Name = in.Model
	}
	if err := in.Connection.Validate(); err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	if err := a.Manager.Store.SaveConnection(in.Connection, in.Key); err != nil {
		return e.BadRequestError("Could not save this connection. Your existing key is unchanged.", nil)
	}
	c, _ := a.Manager.Store.Connection(id)
	return e.JSON(200, c)
}
func (a Admin) deleteConnection(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	err := e.App.RunInTransaction(func(app core.App) error {
		var count int
		if err := app.DB().NewQuery(`SELECT count(*) FROM agents WHERE model_connection={:id}`).Bind(dbx.Params{"id": id}).Row(&count); err != nil {
			return err
		}
		if count > 0 {
			return errors.New("connection still used")
		}
		_, err := app.DB().NewQuery(`DELETE FROM post_connections WHERE id={:id}`).Bind(dbx.Params{"id": id}).Execute()
		return err
	})
	if err != nil {
		return e.BadRequestError("Choose another model for the assistants using this connection before removing it.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
func (a Admin) checkConnection(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	c, err := a.Manager.Store.Connection(id)
	if err != nil {
		return e.NotFoundError("Connection not found.", nil)
	}
	key, err := a.Manager.Store.ConnectionKey(id)
	if err != nil {
		return e.BadRequestError("The saved key could not be opened. Restore the original master key.", nil)
	}
	ctx, cancel := context.WithTimeout(e.Request.Context(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(c.URL, "/")+"/models", nil)
	if err != nil {
		return e.BadRequestError("Check the service URL.", nil)
	}
	if key != "" {
		if c.API == "anthropic-messages" {
			req.Header.Set("x-api-key", key)
			req.Header.Set("anthropic-version", "2023-06-01")
		} else {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return e.JSON(200, map[string]any{"reachable": false, "message": "The service could not be reached. Check its address and that it is running."})
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return e.JSON(200, map[string]any{"reachable": true, "authenticated": false, "message": "The service rejected the API key. Replace it in this connection."})
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return e.JSON(200, map[string]any{"reachable": true, "message": "The service responded but its model list could not be checked. Verify the URL and model ID. No generation was requested."})
	}
	var models struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	listed := false
	if json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&models) == nil {
		for _, m := range models.Data {
			if m.ID == c.Model {
				listed = true
			}
		}
	}
	message := "The service accepted the request. The selected model was not listed; check its ID. No generation was requested."
	if listed {
		message = "Connection accepted; selected model is listed. No generation was requested."
	}
	return e.JSON(200, map[string]any{"reachable": true, "authenticated": true, "model_listed": listed, "message": message})
}

type Draft struct {
	RequestID  string `json:"request_id"`
	CreatedID  string `json:"created_id"`
	Step       int    `json:"step"`
	Name       string `json:"name"`
	Prompt     string `json:"prompt"`
	OwnerID    string `json:"owner_id"`
	OwnerName  string `json:"owner_name"`
	OwnerMXID  string `json:"owner_mxid"`
	Connection string `json:"connection"`
	Bot        string `json:"bot"`
	Homeserver string `json:"homeserver"`
}

func uiValue(e *core.RequestEvent, name string) any {
	var raw string
	var value any
	if e.App.DB().NewQuery(`SELECT value FROM post_ui WHERE admin={:a} AND name={:n}`).Bind(dbx.Params{"a": e.Auth.Id, "n": name}).Row(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &value)
	}
	return value
}
func putUI(e *core.RequestEvent, name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = e.App.DB().NewQuery(`INSERT INTO post_ui(admin,name,value) VALUES({:a},{:n},{:v}) ON CONFLICT(admin,name) DO UPDATE SET value=excluded.value`).Bind(dbx.Params{"a": e.Auth.Id, "n": name, "v": string(raw)}).Execute()
	return err
}
func (a Admin) getDraft(e *core.RequestEvent) error { return e.JSON(200, uiValue(e, "draft")) }
func (a Admin) saveDraft(e *core.RequestEvent) error {
	var draft Draft
	if err := decode(e, &draft); err != nil {
		return err
	}
	if domain.CheckID(draft.RequestID) != nil || len(draft.Prompt) > 64000 || utf8.RuneCountInString(draft.Name) > 100 || draft.Step < 1 || draft.Step > 3 {
		return e.BadRequestError("The setup draft is invalid.", nil)
	}
	if err := putUI(e, "draft", draft); err != nil {
		return e.InternalServerError("Setup progress could not be saved.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
func (a Admin) deleteDraft(e *core.RequestEvent) error {
	if err := putUI(e, "draft", nil); err != nil {
		return e.InternalServerError("Could not clear setup progress.", nil)
	}
	return e.JSON(200, map[string]bool{"ok": true})
}
func (a Admin) getProfile(e *core.RequestEvent) error { return e.JSON(200, uiValue(e, "profile")) }
func (a Admin) saveProfile(e *core.RequestEvent) error {
	var profile struct {
		MXID string `json:"mxid"`
	}
	if err := decode(e, &profile); err != nil {
		return err
	}
	if profile.MXID != "" && !domain.ValidMXID(profile.MXID) {
		return e.BadRequestError("Use your full Matrix ID, or leave it empty.", nil)
	}
	if err := putUI(e, "profile", profile); err != nil {
		return e.InternalServerError("Profile could not be saved.", nil)
	}
	return e.JSON(200, profile)
}
