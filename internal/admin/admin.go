// Package admin serves a small embedded management view and superuser-only operations.
package admin

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"time"

	"github.com/minifish-org/pith-post/internal/agent"
	"github.com/minifish-org/pith-post/internal/domain"
	"github.com/minifish-org/pith-post/internal/matrix"
	"github.com/minifish-org/pith-post/internal/store"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

//go:embed web/*
var assets embed.FS

type Admin struct {
	Manager             *agent.Manager
	Matrix              matrix.Factory
	PersonProfileLookup func(context.Context, string) (matrix.PersonProfile, error)
}

func decode(e *core.RequestEvent, v any) error {
	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, 128<<10)
	d := json.NewDecoder(e.Request.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return e.BadRequestError("Invalid request body", nil)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return e.BadRequestError("Expected one JSON object", nil)
	}
	return nil
}
func (a Admin) Register(e *core.ServeEvent) {
	sub, _ := fs.Sub(assets, "web")
	e.Router.GET("/{$}", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		e.Response.Header().Set("Cache-Control", "no-store")
		e.Response.Header().Set("X-Content-Type-Options", "nosniff")
		e.Response.Header().Set("Referrer-Policy", "no-referrer")
		page, err := assets.ReadFile("web/index.html")
		if err != nil {
			return err
		}
		return e.HTML(200, string(page))
	})
	e.Router.GET("/post/{path...}", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		e.Response.Header().Set("X-Content-Type-Options", "nosniff")
		e.Response.Header().Set("Referrer-Policy", "no-referrer")
		e.Response.Header().Set("Cache-Control", "no-store")
		return apis.Static(sub, true)(e)
	})
	api := e.Router.Group("/api/post")
	api.Bind(sessionAuth(), apis.RequireSuperuserAuth())
	api.GET("/session", a.getSession)
	api.POST("/session", a.createSession)
	api.DELETE("/session", a.logout)
	api.GET("/owners", a.owners)
	api.GET("/owners/{id}/avatar", a.personAvatar)
	api.GET("/defaults", a.getDefaults)
	api.POST("/defaults", a.saveDefaults)
	api.POST("/defaults/check", a.checkServer)
	api.POST("/owners", a.savePerson)
	api.PATCH("/owners/{id}", a.savePerson)
	api.DELETE("/owners/{id}", a.deletePerson)
	api.GET("/account", a.account)
	api.POST("/account/password", a.changePassword)
	api.POST("/assistants", a.createAssistant)
	api.PATCH("/assistants/{id}", a.updateAssistant)
	api.DELETE("/assistants/{id}", a.deleteAssistant)
	api.PATCH("/assistants/{id}/appearance", a.saveAppearance)
	api.PATCH("/assistants/{id}/persona", a.savePersona)
	api.GET("/assistants/{id}/avatar", a.getAvatar)
	api.PUT("/assistants/{id}/avatar", a.putAvatar)
	api.DELETE("/assistants/{id}/avatar", a.removeAvatar)
	api.POST("/assistants/{id}/profile-sync", func(e *core.RequestEvent) error {
		if _, err := a.Manager.Store.Config(e.Request.PathValue("id")); err != nil {
			return e.NotFoundError("Agent not found.", nil)
		}
		a.syncAppearance(e.Request.PathValue("id"))
		return e.JSON(200, map[string]bool{"ok": true})
	})
	api.GET("/connections", a.listConnections)
	api.POST("/connections", a.saveConnection)
	api.PATCH("/connections/{id}", a.saveConnection)
	api.DELETE("/connections/{id}", a.deleteConnection)
	api.POST("/connections/{id}/check", a.checkConnection)
	api.GET("/draft", a.getDraft)
	api.POST("/draft", a.saveDraft)
	api.DELETE("/draft", a.deleteDraft)
	api.GET("/profile", a.getProfile)
	api.POST("/profile", a.saveProfile)
	api.GET("/agents", func(e *core.RequestEvent) error {
		configs, err := a.Manager.Store.Configs()
		if err != nil {
			return e.InternalServerError("Configuration could not be loaded", nil)
		}
		type view struct {
			Config             domain.Config `json:"config"`
			State              domain.State  `json:"state"`
			Starting           bool          `json:"starting"`
			Running            bool          `json:"running"`
			Review             bool          `json:"review"`
			Credentials        bool          `json:"credentials"`
			Password           bool          `json:"password_set"`
			Token              bool          `json:"token_set"`
			Counts             store.Counts  `json:"counts"`
			Draining           bool          `json:"draining"`
			Avatar             string        `json:"avatar"`
			ProfilePending     bool          `json:"profile_pending"`
			ProfileError       string        `json:"profile_error"`
			Revision           string        `json:"revision"`
			AppearanceRevision string        `json:"appearance_revision"`
			PersonaRevision    string        `json:"persona_revision"`
		}
		result := make([]view, 0, len(configs))
		for _, c := range configs {
			state, err := a.Manager.Store.State(c.ID)
			if err != nil {
				return e.InternalServerError("State could not be loaded", nil)
			}
			review, err := a.Manager.Store.HasReview(c.ID)
			if err != nil {
				return e.InternalServerError("Run status could not be loaded", nil)
			}
			secrets, secretErr := a.Manager.Store.Secrets(c.ID)
			if secretErr != nil {
				return e.InternalServerError("Stored credentials could not be opened. Check the original master key.", nil)
			}
			counts, err := a.Manager.Store.Counts(c.ID)
			if err != nil {
				return e.InternalServerError("Task status could not be loaded.", nil)
			}
			profile, err := a.Manager.Store.Profile(c.ID)
			if err != nil {
				return e.InternalServerError("Agent profile could not be loaded.", nil)
			}
			avatar := profile.Hash
			if avatar == "none" {
				avatar = ""
			}
			result = append(result, view{Starting: a.Manager.Starting(c.ID), Avatar: avatar, ProfilePending: c.Name != profile.AppliedName || profile.Hash != profile.AppliedHash, ProfileError: profile.Error, Config: c, State: state, Running: a.Manager.Running(c.ID), Review: review, Credentials: secrets.Password != "" || secrets.AccessToken != "", Password: secrets.Password != "", Token: secrets.AccessToken != "", Counts: counts, Draining: a.Manager.Draining(c.ID), Revision: revision(c), AppearanceRevision: appearanceRevision(c), PersonaRevision: personaRevision(c)})
		}
		e.Response.Header().Set("Cache-Control", "no-store")
		return e.JSON(200, result)
	})
	api.GET("/agents/{id}/history", func(e *core.RequestEvent) error {
		id := e.Request.PathValue("id")
		if _, err := a.Manager.Store.Config(id); err != nil {
			return e.NotFoundError("Agent not found", nil)
		}
		runs, out, err := a.Manager.Store.History(id)
		if err != nil {
			return e.InternalServerError("History could not be loaded", nil)
		}
		// Do not return large binary data in the history view.
		for i := range out {
			var c domain.Content
			if json.Unmarshal([]byte(out[i].Content), &c) == nil {
				size := len(c.Data)
				c.Data = nil
				raw, _ := json.Marshal(struct {
					domain.Content
					Size int `json:"size,omitempty"`
				}{c, size})
				out[i].Content = string(raw)
			}
		}
		e.Response.Header().Set("Cache-Control", "no-store")
		return e.JSON(200, map[string]any{"runs": runs, "outbox": out})
	})
	api.POST("/agents/{id}/{action}", a.action)
}
func (a Admin) action(e *core.RequestEvent) error {
	id, action := e.Request.PathValue("id"), e.Request.PathValue("action")
	c, err := a.Manager.Store.Config(id)
	if err != nil {
		return e.NotFoundError("Agent not found", nil)
	}
	ctx, cancel := context.WithTimeout(e.Request.Context(), 90*time.Second)
	defer cancel()
	var result any = map[string]bool{"ok": true}
	switch action {
	case "enable":
		err = a.Manager.SetEnabled(id, true)
	case "disable":
		err = a.Manager.SetEnabled(id, false)
	case "stop-now":
		if err = a.Manager.SetEnabled(id, false); err == nil {
			err = a.Manager.Stop(id)
		}
	case "start":
		err = a.Manager.Start(id)
	case "stop":
		err = a.Manager.Stop(id)
	case "restart":
		err = a.Manager.Restart(id)
	case "resume":
		err = a.Manager.Resume(id)
	case "new-conversation":
		err = a.Manager.NewConversation(id)
	case "credentials":
		var input matrix.Credentials
		if err = decode(e, &input); err != nil {
			return err
		}
		err = a.Manager.WithStopped(id, func() error { return a.Matrix.ReplaceCredentials(ctx, c, input) })
	case "trigger":
		var input struct {
			Key    string `json:"key"`
			Prompt string `json:"prompt"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		var run string
		run, err = a.Manager.Trigger(id, input.Key, input.Prompt)
		result = map[string]string{"run": run}
	case "cancel-run":
		var input struct {
			Run string `json:"run"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		err = a.Manager.WithStopped(id, func() error { return a.Manager.Store.CancelRun(id, input.Run) })
	case "review":
		var input struct {
			Run     string `json:"run"`
			Replay  bool   `json:"replay"`
			Confirm bool   `json:"confirm_external_effects_reviewed"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		if !input.Confirm {
			return e.BadRequestError("Confirm that possible external effects have been reviewed", nil)
		}
		err = a.Manager.WithStopped(id, func() error { return a.Manager.Store.Review(id, input.Run, input.Replay) })
	case "confirm-recovery-impossible", "reset-identity":
		var input struct {
			Reason  string `json:"reason"`
			Confirm bool   `json:"confirm_recovery_impossible"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		if !input.Confirm {
			return e.BadRequestError("Confirm that original identity recovery is impossible", nil)
		}
		if err = store.ValidateReason(input.Reason); err != nil {
			return e.BadRequestError(err.Error(), nil)
		}
		err = a.Manager.WithStopped(id, func() error {
			if action == "reset-identity" {
				return a.Matrix.Reset(ctx, c, input.Reason)
			}
			return a.Manager.Store.UpdateState(id, func(s *domain.State) error { s.RecoveryImpossible = input.Reason; return nil })
		})
	case "bind-room":
		var input struct {
			Room string `json:"room"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		err = a.Manager.WithStopped(id, func() error { return a.Matrix.Bind(ctx, c, input.Room) })
	case "discard-delivery":
		var input struct {
			ID      string `json:"id"`
			Reason  string `json:"reason"`
			Confirm bool   `json:"confirm_may_already_be_visible"`
		}
		if err = decode(e, &input); err != nil {
			return err
		}
		if !input.Confirm {
			return e.BadRequestError("Confirm that the delivery may already be visible", nil)
		}
		err = a.Manager.WithStopped(id, func() error { return a.Manager.Store.DiscardDelivery(id, input.ID, input.Reason) })
	default:
		return e.NotFoundError("Unknown management operation", nil)
	}
	if err != nil {
		if errors.Is(err, domain.ErrPaused) || errors.Is(err, domain.ErrReview) || errors.Is(err, domain.ErrStopped) || errors.Is(err, domain.ErrAwaitingOwner) {
			return e.BadRequestError(err.Error(), nil)
		}
		// Intentionally exclude raw database, model, and homeserver errors from responses and logs.
		return e.BadRequestError("Operation failed. Check status, stop-state requirements, and the recovery guide.", nil)
	}
	if err = a.Manager.Store.Audit(id, action, "Administrator operation completed"); err != nil {
		return e.InternalServerError("Operation completed but audit recording failed", nil)
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(200, result)
}
