package store

import (
	"time"

	"github.com/pocketbase/dbx"
)

type EncryptedInbound struct {
	Event        string `db:"event"`
	Raw          []byte `db:"raw"`
	Conversation int    `db:"conversation"`
}

// HoldEncrypted commits ciphertext before advancing the Matrix sync cursor.
func (s *Store) HoldEncrypted(agent, event string, raw []byte) error {
	state, err := s.State(agent)
	if err != nil {
		return err
	}
	_, err = s.App.DB().NewQuery(`INSERT INTO post_inbox(agent,event,raw,conversation,created) VALUES({:a},{:e},{:r},{:c},{:t}) ON CONFLICT(agent,event) DO NOTHING`).Bind(dbx.Params{"a": agent, "e": event, "r": raw, "c": state.Conversation, "t": time.Now().UnixMilli()}).Execute()
	return err
}
func (s *Store) WaitingKeys(agent string) ([]EncryptedInbound, error) {
	rows := []EncryptedInbound{}
	err := s.App.DB().NewQuery(`SELECT event,raw,conversation FROM post_inbox WHERE agent={:a} AND handled=0 ORDER BY created,rowid LIMIT 100`).Bind(dbx.Params{"a": agent}).All(&rows)
	return rows, err
}
func (s *Store) HandledEncrypted(agent, event string) error {
	_, err := s.App.DB().NewQuery(`UPDATE post_inbox SET handled=1,raw=NULL WHERE agent={:a} AND event={:e}`).Bind(dbx.Params{"a": agent, "e": event}).Execute()
	return err
}
