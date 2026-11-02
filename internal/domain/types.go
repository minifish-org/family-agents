// Package domain defines the boundaries shared by storage, execution, and Matrix.
package domain

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var (
	ErrPaused         = errors.New("delivery paused; verify the owner-only room and resume as an administrator")
	ErrReview         = errors.New("an interrupted run requires administrator review")
	ErrStopped        = errors.New("agent is stopped")
	ErrCryptoRecovery = errors.New("original Matrix identity requires recovery")
)

const MaxAttachment = 8 << 20
const MaxText = 24000

var mxidPattern = regexp.MustCompile(`^@[^\s:]+:[^\s/]+$`)

func ValidMXID(s string) bool { return mxidPattern.MatchString(s) }

// Config contains no credentials. Identity fields are immutable after creation.
type Config struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Owner         string `json:"owner"`
	Bot           string `json:"bot"`
	Homeserver    string `json:"homeserver"`
	Prompt        string `json:"prompt"`
	Model         string `json:"model"`
	ModelURL      string `json:"model_url"`
	ModelAPI      string `json:"model_api"`
	ContextWindow int    `json:"context_window"`
	MaxTokens     int    `json:"max_tokens"`
	AutoStart     bool   `json:"auto_start"`
	AutoReset     bool   `json:"auto_reset"`
}

func ValidURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Host != "" && (u.Scheme == "https" || u.Scheme == "http") && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}
func (c Config) Validate() error {
	if !ValidMXID(c.Owner) || !ValidMXID(c.Bot) || c.Owner == c.Bot {
		return errors.New("distinct full owner and bot Matrix IDs are required")
	}
	if !ValidURL(c.Homeserver) || !ValidURL(c.ModelURL) {
		return errors.New("service URLs must use HTTP(S) without credentials, query, or fragment")
	}
	if c.Name == "" || c.Model == "" || strings.TrimSpace(c.Prompt) == "" {
		return errors.New("name, model, and system prompt are required")
	}
	if c.ModelAPI != "openai-completions" && c.ModelAPI != "openai-responses" && c.ModelAPI != "anthropic-messages" {
		return errors.New("unsupported model API")
	}
	if c.MaxTokens < 1 || c.ContextWindow < c.MaxTokens {
		return errors.New("context window must be at least the positive output token limit")
	}
	return nil
}

// Secrets are only serialized inside the authenticated encryption envelope.
type Secrets struct {
	Password    string `json:"password,omitempty"`
	AccessToken string `json:"access_token,omitempty"`
	ModelKey    string `json:"model_key,omitempty"`
	PickleKey   []byte `json:"pickle_key"`
}

type State struct {
	Device             string `json:"device"`
	Room               string `json:"room"`
	RoomCreating       bool   `json:"room_creating"`
	CryptoReady        bool   `json:"crypto_ready"`
	Generation         int    `json:"generation"`
	Conversation       int    `json:"conversation"`
	Paused             string `json:"paused"`
	SecurityEpoch      uint64 `json:"security_epoch"`
	RecoveryImpossible string `json:"recovery_impossible"`
	ResetCount         int    `json:"reset_count"`
	ResetReason        string `json:"reset_reason"`
	LastError          string `json:"last_error"`
}

type Content struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
	Name string `json:"name,omitempty"`
	MIME string `json:"mime,omitempty"`
	Data []byte `json:"data,omitempty"`
}

func (c Content) Validate() error {
	switch c.Kind {
	case "text":
		if strings.TrimSpace(c.Text) == "" || len(c.Text) > MaxText {
			return errors.New("text must contain 1 to 24000 bytes")
		}
	case "image", "file":
		if len(c.Data) == 0 || len(c.Data) > MaxAttachment {
			return errors.New("attachment must contain 1 to 8388608 bytes")
		}
		if c.Name == "" || len(c.Name) > 255 || strings.ContainsAny(c.Name, "/\\\r\n") {
			return errors.New("a plain attachment filename is required")
		}
		if c.MIME == "" || strings.ContainsAny(c.MIME, "\r\n") {
			return errors.New("attachment MIME type is required")
		}
		if c.Kind == "image" && c.MIME != "image/png" && c.MIME != "image/jpeg" && c.MIME != "image/gif" && c.MIME != "image/webp" {
			return errors.New("unsupported image MIME type; use file delivery instead")
		}
	default:
		return errors.New("content must be text, image, or file")
	}
	return nil
}

type Inbound struct {
	EventID, Room, Sender, Text string
	Decrypted                   bool
}
type Member struct{ MXID, Membership string }
type Snapshot struct {
	Room      string
	Encrypted bool
	Members   []Member
}

// OwnerOnly requires a full, authoritative membership snapshot, including invitations.
func OwnerOnly(c Config, room string, s Snapshot) error {
	if room == "" || room != s.Room || !s.Encrypted {
		return ErrPaused
	}
	owner, bot := false, false
	seen := map[string]bool{}
	for _, m := range s.Members {
		if seen[m.MXID] {
			return ErrPaused
		}
		seen[m.MXID] = true
		if m.MXID == c.Owner {
			owner = m.Membership == "join"
		}
		if m.MXID == c.Bot {
			bot = m.Membership == "join"
		}
		switch m.Membership {
		case "join", "invite", "knock":
			if m.MXID != c.Owner && m.MXID != c.Bot {
				return ErrPaused
			}
		case "leave", "ban":
		default:
			return ErrPaused
		}
	}
	if !owner || !bot {
		return ErrPaused
	}
	return nil
}

type Transport interface {
	Snapshot(context.Context) (Snapshot, error)
	Prepare(context.Context, Content) ([]byte, error)
	Send(context.Context, []byte, string) error
	Run(context.Context, func(Inbound) error, func() error) error
	Close() error
}
type Factory func(context.Context, Config) (Transport, error)
type Model interface {
	Generate(context.Context, Config, string, string, string, string) ([]Content, error)
}

// Stable identifiers never contain user-controlled path components.
func CheckID(s string) error {
	if !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`).MatchString(s) {
		return fmt.Errorf("invalid internal identifier")
	}
	return nil
}
