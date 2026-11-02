package matrix

import (
	"context"
	"errors"

	"github.com/minifish-org/pith-post/internal/domain"
)

type Credentials struct {
	Password    *string `json:"password"`
	AccessToken *string `json:"access_token"`
	ModelKey    *string `json:"model_key"`
}

// ReplaceCredentials must run under the manager's stopped-agent lifecycle lock.
func (f Factory) ReplaceCredentials(ctx context.Context, c domain.Config, input Credentials) error {
	secrets, err := f.Store.Secrets(c.ID)
	if err != nil {
		return err
	}
	if input.Password != nil {
		secrets.Password = *input.Password
	}
	if input.ModelKey != nil {
		secrets.ModelKey = *input.ModelKey
	}
	if input.AccessToken != nil {
		pending, err := f.Store.Unsettled(c.ID)
		if err != nil {
			return err
		}
		if pending {
			return errors.New("resolve pending work before replacing the access token; transaction scopes may change")
		}
		if *input.AccessToken == "" {
			return errors.New("access token replacement cannot be empty")
		}
		cli, err := newClient(c, *input.AccessToken)
		if err != nil {
			return err
		}
		who, err := cli.Whoami(ctx)
		if err != nil || string(who.UserID) != c.Bot || who.DeviceID == "" {
			return errors.New("replacement token identity could not be verified")
		}
		state, err := f.Store.State(c.ID)
		if err != nil {
			return err
		}
		if state.Device != "" && state.Device != string(who.DeviceID) {
			return errors.New("replacement token must belong to the original device")
		}
		secrets.AccessToken = *input.AccessToken
	}
	return f.Store.PutSecrets(c.ID, secrets)
}
func (f Factory) Reset(ctx context.Context, c domain.Config, reason string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return f.Store.ResetIdentity(c.ID, randomDevice(), reason)
}
