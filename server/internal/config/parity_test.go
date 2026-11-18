package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

type goldenCase struct {
	Name string            `json:"name"`
	Env  map[string]string `json:"env"`
}

type goldenResult struct {
	OK     bool           `json:"ok"`
	Config map[string]any `json:"config"`
	Keys   []string       `json:"keys"`
}

func loadGolden(t *testing.T) ([]goldenCase, map[string]goldenResult) {
	t.Helper()
	dir := filepath.Join("..", "..", "testdata", "golden")
	var cases []goldenCase
	var results map[string]goldenResult
	for file, into := range map[string]any{"config-cases.json": &cases, "config.golden.json": &results} {
		b, err := os.ReadFile(filepath.Join(dir, file))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, into); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
	}
	if len(cases) == 0 || len(cases) != len(results) {
		t.Fatalf("golden files disagree: %d cases, %d results", len(cases), len(results))
	}
	return cases, results
}

// TestConfigMatchesNodeGolden is the parity gate: every env case the Node loadConfig accepted is accepted
// here with the same values, and every refused case is refused naming the same keys. REDIS_URL is the one
// intended difference (the Go backend has no Redis): Node's REDIS_URL errors are not expected here.
func TestConfigMatchesNodeGolden(t *testing.T) {
	cases, results := loadGolden(t)
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			want := results[c.Name]
			cfg, err := Load(c.Env)
			if want.OK {
				if err != nil {
					t.Fatalf("Node accepted, Go refused: %v", err)
				}
				node := want.Config
				delete(node, "redisUrl")
				if got := parityJSON(t, cfg); !reflect.DeepEqual(got, node) {
					gb, _ := json.MarshalIndent(got, "", "  ")
					nb, _ := json.MarshalIndent(node, "", "  ")
					t.Fatalf("config differs\n go:   %s\n node: %s", gb, nb)
				}
				return
			}
			wantKeys := slices.DeleteFunc(slices.Clone(want.Keys), func(k string) bool { return k == "REDIS_URL" })
			if len(wantKeys) == 0 {
				if err != nil {
					t.Fatalf("Node refused only REDIS_URL, so Go must accept; got %v", err)
				}
				return
			}
			var inv *InvalidError
			if !errors.As(err, &inv) {
				t.Fatalf("Node refused %v, Go returned %v", wantKeys, err)
			}
			got := slices.Clone(inv.Keys)
			slices.Sort(got)
			if !slices.Equal(got, wantKeys) {
				t.Fatalf("refused keys: go %v, node %v", got, wantKeys)
			}
		})
	}
}

// parityJSON renders a Config in the shape the Node Config has, through a JSON round trip so numbers
// compare as float64 like the golden file's. It lives in a test file on purpose: production code has no way
// to marshal a Config (it holds secrets).
func parityJSON(t *testing.T, c Config) map[string]any {
	t.Helper()
	nullable := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	list := func(s []string) []string {
		if s == nil {
			return []string{}
		}
		return s
	}
	kek := func(k Kek) map[string]any {
		return map[string]any{"version": k.Version, "key": k.Key}
	}
	m := map[string]any{
		"nodeEnv": c.NodeEnv, "databaseUrl": c.DatabaseURL, "hermesImage": c.HermesImage, "port": c.Port,
		"adminToken": c.AdminToken, "dockerSocketPath": c.DockerSocketPath, "masterKey": c.MasterKey,
		"runtime": c.Runtime, "diskQuota": c.DiskQuota, "diskCheckIntervalMs": c.DiskCheckIntervalMs,
		"egressPolicy": c.EgressPolicy, "dnsResolvers": list(c.DNSResolvers),
		"supabaseUrl": nullable(c.SupabaseURL), "dashboardOrigin": nullable(c.DashboardOrigin),
		"corsExtraOrigins": list(c.CORSExtraOrigins), "betaAllowedEmails": list(c.BetaAllowedEmails),
		"adminEmails": list(c.AdminEmails), "maxInstancesPerTenant": c.MaxInstancesPerTenant,
		"freeBetaSlots": c.FreeBetaSlots, "paidCheckoutOpen": c.PaidCheckoutOpen,
		"turnstileSecret": nullable(c.TurnstileSecret),
	}
	if c.CanaryImage != "" {
		m["canaryImage"] = c.CanaryImage
	}
	if c.CanaryPrivateIP != "" {
		m["canaryPrivateIp"] = c.CanaryPrivateIP
	}
	if c.MaxTotalInstances > 0 {
		m["maxTotalInstances"] = c.MaxTotalInstances
	} else {
		m["maxTotalInstances"] = nil
	}
	ops := map[string]any{"telegram": nil}
	if c.Ops.Telegram != nil {
		ops["telegram"] = map[string]any{"botToken": c.Ops.Telegram.BotToken, "chatId": c.Ops.Telegram.ChatID}
	}
	m["ops"] = ops
	m["secrets"] = nil
	if c.Secrets != nil {
		s := map[string]any{"current": kek(c.Secrets.Current), "previous": nil}
		if c.Secrets.Previous != nil {
			s["previous"] = kek(*c.Secrets.Previous)
		}
		m["secrets"] = s
	}
	m["mail"] = nil
	if c.Mail != nil {
		m["mail"] = map[string]any{"host": c.Mail.Host, "port": c.Mail.Port, "user": c.Mail.User, "pass": c.Mail.Pass, "from": c.Mail.From}
	}
	m["billing"] = nil
	if c.Billing != nil {
		b := map[string]any{"gateway": c.Billing.Gateway, "duitku": nil, "sumopod": nil}
		if d := c.Billing.Duitku; d != nil {
			b["duitku"] = map[string]any{"merchantCode": d.MerchantCode, "apiKey": d.APIKey, "env": d.Env, "callbackUrl": d.CallbackURL}
		}
		if s := c.Billing.SumoPod; s != nil {
			b["sumopod"] = map[string]any{"apiKey": s.APIKey, "webhookToken": s.WebhookToken, "webhookSecret": nullable(s.WebhookSecret), "env": s.Env, "callbackUrl": s.CallbackURL}
		}
		m["billing"] = b
	}
	m["router"] = nil
	if r := c.Router; r != nil {
		m["router"] = map[string]any{"apiUrl": r.APIURL, "adminKey": r.AdminKey, "defaultModel": r.DefaultModel, "emailDomain": r.EmailDomain}
	}
	b, err := json.Marshal(m) // []byte keys marshal as base64, like the generator's Buffer normalization
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
