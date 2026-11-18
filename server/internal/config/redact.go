package config

import (
	"errors"
	"log/slog"
)

// Every type here that holds a secret renders only its non-secret facts, however it is printed: slog (LogValue),
// %v/%+v/%s (String), %#v (GoString). JSON is refused outright, so a config can never end up in a response or a
// JSON log line by accident.

var errNoJSON = errors.New("config: holds secrets and is never encoded as JSON")

func (c Config) GoString() string             { return c.String() }
func (Config) MarshalJSON() ([]byte, error)   { return nil, errNoJSON }
func (k Kek) LogValue() slog.Value            { return slog.GroupValue(slog.Int("version", k.Version)) }
func (k Kek) String() string                  { return k.LogValue().String() }
func (k Kek) GoString() string                { return k.String() }
func (Kek) MarshalJSON() ([]byte, error)      { return nil, errNoJSON }
func (s Secrets) String() string              { return s.LogValue().String() }
func (s Secrets) GoString() string            { return s.String() }
func (Secrets) MarshalJSON() ([]byte, error)  { return nil, errNoJSON }
func (o Ops) String() string                  { return o.LogValue().String() }
func (o Ops) GoString() string                { return o.String() }
func (Ops) MarshalJSON() ([]byte, error)      { return nil, errNoJSON }
func (t Telegram) String() string             { return t.LogValue().String() }
func (t Telegram) GoString() string           { return t.String() }
func (Telegram) MarshalJSON() ([]byte, error) { return nil, errNoJSON }
func (m Mail) String() string                 { return m.LogValue().String() }
func (m Mail) GoString() string               { return m.String() }
func (Mail) MarshalJSON() ([]byte, error)     { return nil, errNoJSON }
func (b Billing) String() string              { return b.LogValue().String() }
func (b Billing) GoString() string            { return b.String() }
func (Billing) MarshalJSON() ([]byte, error)  { return nil, errNoJSON }
func (d Duitku) String() string               { return d.LogValue().String() }
func (d Duitku) GoString() string             { return d.String() }
func (Duitku) MarshalJSON() ([]byte, error)   { return nil, errNoJSON }
func (s SumoPod) String() string              { return s.LogValue().String() }
func (s SumoPod) GoString() string            { return s.String() }
func (SumoPod) MarshalJSON() ([]byte, error)  { return nil, errNoJSON }
func (r Router) String() string               { return r.LogValue().String() }
func (r Router) GoString() string             { return r.String() }
func (Router) MarshalJSON() ([]byte, error)   { return nil, errNoJSON }

func (s Secrets) LogValue() slog.Value {
	attrs := []slog.Attr{slog.Int("currentVersion", s.Current.Version)}
	if s.Previous != nil {
		attrs = append(attrs, slog.Int("previousVersion", s.Previous.Version))
	}
	return slog.GroupValue(attrs...)
}

func (o Ops) LogValue() slog.Value { return slog.GroupValue(slog.Bool("telegram", o.Telegram != nil)) }

func (t Telegram) LogValue() slog.Value { return slog.GroupValue(slog.String("chatId", t.ChatID)) }

func (m Mail) LogValue() slog.Value {
	return slog.GroupValue(slog.String("host", m.Host), slog.Int("port", m.Port), slog.String("from", m.From))
}

func (b Billing) LogValue() slog.Value {
	return slog.GroupValue(slog.String("gateway", b.Gateway), slog.Bool("duitku", b.Duitku != nil), slog.Bool("sumopod", b.SumoPod != nil))
}

func (d Duitku) LogValue() slog.Value {
	return slog.GroupValue(slog.String("env", d.Env), slog.String("callbackUrl", d.CallbackURL))
}

func (s SumoPod) LogValue() slog.Value {
	return slog.GroupValue(slog.String("env", s.Env), slog.String("callbackUrl", s.CallbackURL), slog.Bool("signedWebhooks", s.WebhookSecret != ""))
}

func (r Router) LogValue() slog.Value {
	return slog.GroupValue(slog.String("apiUrl", r.APIURL), slog.String("defaultModel", r.DefaultModel), slog.String("emailDomain", r.EmailDomain))
}
