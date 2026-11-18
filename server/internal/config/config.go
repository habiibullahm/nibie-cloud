// Package config reads the backend's environment. It accepts and refuses exactly what the Node backend's
// src/config/env.ts did (pinned by testdata/golden/config.golden.json), with one intended difference:
// REDIS_URL is ignored, because the Go backend keeps its job queue in Postgres.
//
// Errors name the failing keys, never their values.
package config

import (
	"bufio"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"regexp"
	"slices"
	"strings"
)

// Config is the parsed environment. An empty string means "not set" for every optional text field.
// It holds secrets: log it only through LogValue (slog does that automatically) and never marshal it.
type Config struct {
	NodeEnv             string // development | test | production
	DatabaseURL         string
	HermesImage         string
	Port                int
	AdminToken          string
	DockerSocketPath    string
	MasterKey           string
	Runtime             string // runc | runsc
	DiskQuota           string // enforce | off
	DiskCheckIntervalMs int
	EgressPolicy        string // enforce | off
	CanaryImage         string
	CanaryPrivateIP     string
	// DNSResolvers is empty when unset: tenant containers keep Docker's embedded resolver.
	DNSResolvers []string
	// SupabaseURL is the origin without a trailing slash, or empty when the customer API is disabled.
	SupabaseURL     string
	DashboardOrigin string
	// CORSExtraOrigins is development only (refused in production).
	CORSExtraOrigins []string
	// BetaAllowedEmails and AdminEmails are lowercased and trimmed. Empty means nobody (fail closed).
	BetaAllowedEmails     []string
	AdminEmails           []string
	MaxInstancesPerTenant int
	// MaxTotalInstances is 0 when there is no whole-server cap.
	MaxTotalInstances int
	FreeBetaSlots     int
	PaidCheckoutOpen  bool
	TurnstileSecret   string
	Ops               Ops
	// RedisURLIgnored is true when REDIS_URL was set: serve logs one warning about it.
	RedisURLIgnored bool
	Secrets         *Secrets
	Mail            *Mail
	Billing         *Billing
	Router          *Router
}

type Kek struct {
	Version int
	Key     []byte
}

type Secrets struct {
	Current  Kek
	Previous *Kek
}

type Ops struct{ Telegram *Telegram }

type Telegram struct{ BotToken, ChatID string }

type Mail struct {
	Host string
	Port int
	User string
	Pass string
	From string
}

type Billing struct {
	Gateway string // sumopod | duitku | both
	Duitku  *Duitku
	SumoPod *SumoPod
}

type Duitku struct{ MerchantCode, APIKey, Env, CallbackURL string }

// SumoPod.WebhookSecret is empty when unset: then the webhook token alone authenticates webhooks.
type SumoPod struct{ APIKey, WebhookToken, WebhookSecret, Env, CallbackURL string }

type Router struct{ APIURL, AdminKey, DefaultModel, EmailDomain string }

// InvalidError lists the keys that failed, in the order Node reported them. It never carries values.
type InvalidError struct{ Keys []string }

func (e *InvalidError) Error() string { return "Invalid configuration: " + strings.Join(e.Keys, ", ") }

// LogValue reports only non-secret facts, so a Config passed to slog cannot leak a key or a password.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("nodeEnv", c.NodeEnv), slog.Int("port", c.Port), slog.String("runtime", c.Runtime),
		slog.String("diskQuota", c.DiskQuota), slog.String("egressPolicy", c.EgressPolicy),
		slog.Bool("customerApi", c.SupabaseURL != ""), slog.Bool("secrets", c.Secrets != nil),
		slog.Bool("mail", c.Mail != nil), slog.Bool("billing", c.Billing != nil),
		slog.Bool("router", c.Router != nil), slog.Bool("alerts", c.Ops.Telegram != nil),
	)
}

// String is LogValue as text, so fmt verbs cannot leak secrets either.
func (c Config) String() string { return c.LogValue().String() }

// FromEnviron reads the process environment. Outside production, a .env file in the working directory
// fills in variables the environment does not set (the environment wins), like the Node `dotenv/config`.
func FromEnviron() (Config, error) {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	if env["NODE_ENV"] != "production" {
		if err := mergeDotEnv(".env", env); err != nil {
			return Config{}, err
		}
	}
	return Load(env)
}

func mergeDotEnv(path string, env map[string]string) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read .env: %w", err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			continue
		}
		v = strings.TrimSpace(v)
		switch {
		case len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"':
			v = strings.ReplaceAll(v[1:len(v)-1], `\n`, "\n")
		case len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'':
			v = v[1 : len(v)-1]
		default:
			if i := strings.Index(v, " #"); i >= 0 {
				v = strings.TrimSpace(v[:i])
			}
		}
		if _, set := env[k]; !set {
			env[k] = v
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("read .env: %w", err)
	}
	return nil
}

var (
	mailAddress   = regexp.MustCompile(`^[^@<>` + jsWS + `]+@[^@<>` + jsWS + `]+\.[^@<>` + jsWS + `]+$`)
	digestPinned  = regexp.MustCompile(`^[^@` + jsWS + `]+@sha256:[0-9a-f]{64}$`)
	svixSecret    = regexp.MustCompile(`^whsec_[A-Za-z0-9+/]+={0,2}$`)
	emailDomain   = regexp.MustCompile(`^[a-z0-9.-]+\.[a-z]{2,}$`)
	telegramToken = regexp.MustCompile(`^[0-9]{6,}:[A-Za-z0-9_-]{30,}$`)
	telegramChat  = regexp.MustCompile(`^-?[0-9]{1,20}$`)
	resolverSep   = regexp.MustCompile(`[,` + jsWS + `]+`)
)

// parser collects failing keys like zod did. An "abort" failure (missing value, unknown enum value, not a
// number, not an integer) leaves no value, and then zod skipped the cross-field rules; any other failure
// (length, range, format) keeps the value and the cross-field rules still run.
type parser struct {
	env     map[string]string
	keys    []string
	aborted bool
}

func (p *parser) fail(key string, abort bool) {
	if !slices.Contains(p.keys, key) {
		p.keys = append(p.keys, key)
	}
	if abort {
		p.aborted = true
	}
}

// opt is zod's emptyToUndefined: unset and blank both mean "not set".
func (p *parser) opt(key string) string {
	if v, ok := p.env[key]; ok && jsTrim(v) != "" {
		return v
	}
	return ""
}

func (p *parser) required(key string, minLen int) string {
	v, ok := p.env[key]
	if !ok {
		p.fail(key, true)
		return ""
	}
	if jsLen(v) < minLen {
		p.fail(key, false)
	}
	return v
}

// enum reads an enum with a default. blankIsUnset applies emptyToUndefined first.
func (p *parser) enum(key, def string, blankIsUnset bool, allowed ...string) string {
	v, ok := p.env[key]
	if !ok || (blankIsUnset && jsTrim(v) == "") {
		return def
	}
	if !slices.Contains(allowed, v) {
		p.fail(key, true)
		return def
	}
	return v
}

// number is z.coerce.number().int().min(lo).max(hi). It returns the value and whether one was set; the
// default is used when the key is unset (or blank, with blankIsUnset).
func (p *parser) number(key string, lo, hi int, def *int, blankIsUnset bool) (int, bool) {
	v, ok := p.env[key]
	if !ok || (blankIsUnset && jsTrim(v) == "") {
		if def != nil {
			return *def, true
		}
		return 0, false
	}
	f := jsNumber(v)
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		p.fail(key, true)
		return 0, false
	}
	// zod's .int() takes safe integers only; a bigger one fails without aborting, and the value stays (clamped
	// here, keeping its sign, so it can never wrap around into a negative or a small number).
	if math.Abs(f) > maxSafeInteger {
		p.fail(key, false)
		if f > 0 {
			return math.MaxInt, true
		}
		return math.MinInt, true
	}
	if f < float64(lo) || f > float64(hi) {
		p.fail(key, false)
	}
	return int(f), true
}

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER (2^53 - 1).
const maxSafeInteger = 1<<53 - 1

// text is an emptyToUndefined string with a format check that keeps the value when it fails.
func (p *parser) text(key string, valid func(string) bool) string {
	v := p.opt(key)
	if v != "" && valid != nil && !valid(v) {
		p.fail(key, false)
	}
	return v
}

func maxLen(n int) func(string) bool { return func(v string) bool { return jsLen(v) <= n } }

func ptr(n int) *int { return &n }

func splitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = jsTrim(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func lowerList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.ToLower(jsTrim(s)); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func resolvers(v string) []string {
	var out []string
	for _, s := range resolverSep.Split(v, -1) {
		if s = jsTrim(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Load parses an environment given as a map. Missing keys and keys set to "" are different, as in Node.
func Load(env map[string]string) (Config, error) {
	p := &parser{env: env}

	// Fields, in the order of the Node schema (that order is the order of the keys in the error).
	nodeEnv := p.enum("NODE_ENV", "development", false, "development", "test", "production")
	databaseURL := p.required("DATABASE_URL", 1)
	hermesImage := p.required("HERMES_IMAGE", 1)
	adminToken := p.required("ADMIN_TOKEN", 24)
	port, _ := p.number("PORT", 1, 65535, ptr(3000), false)
	dockerSocket, ok := env["DOCKER_SOCKET_PATH"]
	if !ok {
		dockerSocket = "/var/run/docker.sock"
	}
	masterKey := p.required("HERMES_MASTER_KEY", 32)
	runtime := p.enum("HERMES_RUNTIME", "runc", false, "runc", "runsc")
	diskQuota := p.enum("HERMES_DISK_QUOTA", "enforce", false, "enforce", "off")
	diskInterval, _ := p.number("HERMES_DISK_CHECK_INTERVAL_MS", 1000, math.MaxInt, ptr(300_000), false)
	egress := p.enum("HERMES_EGRESS_POLICY", "enforce", false, "enforce", "off")
	canaryImage := p.text("HERMES_CANARY_IMAGE", nil)
	canaryIP := p.text("HERMES_CANARY_PRIVATE_IP", isIPv4)
	dnsRaw := p.text("HERMES_DNS_RESOLVERS", nil)
	supabase := p.text("SUPABASE_URL", func(v string) bool { return exactOrigin(strings.TrimSuffix(v, "/"), true) })
	dashboard := p.text("DASHBOARD_ORIGIN", func(v string) bool { return exactOrigin(v, false) })
	corsExtra := p.text("CORS_EXTRA_ORIGINS", nil)
	beta := env["BETA_ALLOWED_EMAILS"]
	adminEmails := p.text("ADMIN_EMAILS", func(v string) bool {
		for _, s := range splitList(v) {
			if !mailAddress.MatchString(s) {
				return false
			}
		}
		return true
	})
	p.opt("REDIS_URL") // ignored on purpose (see the package comment)
	kek := p.text("SECRETS_KEK", func(v string) bool { _, ok := kek32(v); return ok })
	kekVersion, kekVersionSet := p.number("SECRETS_KEK_VERSION", 1, 1_000_000, nil, true)
	kekPrev := p.text("SECRETS_KEK_PREVIOUS", func(v string) bool { _, ok := kek32(v); return ok })
	kekPrevVersion, kekPrevVersionSet := p.number("SECRETS_KEK_PREVIOUS_VERSION", 1, 1_000_000, nil, true)
	maxPerTenant, _ := p.number("MAX_INSTANCES_PER_TENANT", 1, 1000, ptr(1), true)
	maxTotal, _ := p.number("MAX_TOTAL_INSTANCES", 1, 100_000, nil, true)
	freeSlots, _ := p.number("FREE_BETA_SLOTS", 0, 100_000, ptr(0), true)
	turnstile := p.text("TURNSTILE_SECRET_KEY", maxLen(200))
	paidOpen := p.enum("PAID_CHECKOUT_OPEN", "true", true, "true", "false")
	smtpHost := p.text("SUMOPOD_SMTP_HOST", nil)
	smtpPort, smtpPortSet := p.number("SUMOPOD_SMTP_PORT", 1, 65535, nil, true)
	smtpUser := p.text("SUMOPOD_SMTP_USER", nil)
	smtpPass := p.text("SUMOPOD_SMTP_PASS", nil)
	mailFrom := p.text("MAIL_FROM", mailAddress.MatchString)
	duitkuMerchant := p.text("DUITKU_MERCHANT_CODE", nil)
	duitkuKey := p.text("DUITKU_API_KEY", nil)
	duitkuEnv := p.enum("DUITKU_ENV", "sandbox", true, "sandbox", "production")
	callbackOK := func(v string) bool { return maxLen(255)(v) && isHTTPSURL(v) }
	duitkuCallback := p.text("DUITKU_CALLBACK_URL", callbackOK)
	sumopodKey := p.text("SUMOPOD_API_KEY", nil)
	sumopodToken := p.text("SUMOPOD_WEBHOOK_TOKEN", nil)
	sumopodSecret := p.text("SUMOPOD_WEBHOOK_SECRET", svixSecret.MatchString)
	sumopodEnv := p.enum("SUMOPOD_ENV", "sandbox", true, "sandbox", "production")
	sumopodCallback := p.text("SUMOPOD_CALLBACK_URL", callbackOK)
	gateway := p.enum("BILLING_GATEWAY", "sumopod", true, "sumopod", "duitku", "both")
	routerKey := p.text("NIBIEROUTER_ADMIN_KEY", nil)
	routerModel := p.text("NIBIEROUTER_DEFAULT_MODEL", nil)
	routerURL := p.text("NIBIEROUTER_API_URL", func(v string) bool { return maxLen(255)(v) && isRouterOrigin(v) })
	if routerURL == "" {
		routerURL = "https://router.nibie.app"
	}
	routerDomain := p.text("NIBIEROUTER_USER_EMAIL_DOMAIN", func(v string) bool { return maxLen(100)(v) && emailDomain.MatchString(v) })
	if routerDomain == "" {
		routerDomain = "cloud.nibie.app"
	}
	opsToken := p.text("OPS_TELEGRAM_BOT_TOKEN", telegramToken.MatchString)
	opsChat := p.text("OPS_TELEGRAM_CHAT_ID", telegramChat.MatchString)

	// Cross-field rules, in the Node superRefine order. zod skipped them after an aborting field error.
	if !p.aborted {
		prod := nodeEnv == "production"
		if (opsToken == "") != (opsChat == "") {
			p.fail("OPS_TELEGRAM_BOT_TOKEN", false)
		}
		if (routerKey == "") != (routerModel == "") {
			p.fail("NIBIEROUTER_ADMIN_KEY", false)
		}
		if prod && diskQuota == "off" {
			p.fail("HERMES_DISK_QUOTA", false)
		}
		if prod && egress == "off" {
			p.fail("HERMES_EGRESS_POLICY", false)
		}
		if prod && runtime != "runsc" {
			p.fail("HERMES_RUNTIME", false)
		}
		if prod && kek == "" {
			p.fail("SECRETS_KEK", false)
		}
		if kekPrev != "" && kek == "" {
			p.fail("SECRETS_KEK_PREVIOUS", false)
		}
		currentVersion := 1
		if kekVersionSet {
			currentVersion = kekVersion
		}
		if kekPrev != "" && (!kekPrevVersionSet || kekPrevVersion == currentVersion) {
			p.fail("SECRETS_KEK_PREVIOUS_VERSION", false)
		}
		if corsExtra != "" {
			if prod {
				p.fail("CORS_EXTRA_ORIGINS", false)
			} else {
				for _, o := range splitList(corsExtra) {
					if !exactOrigin(o, false) {
						p.fail("CORS_EXTRA_ORIGINS", false)
					}
				}
			}
		}
		requireAll := func(set map[string]bool, order ...string) {
			any := false
			for _, k := range order {
				any = any || set[k]
			}
			if any {
				for _, k := range order {
					if !set[k] {
						p.fail(k, false)
					}
				}
			}
		}
		requireAll(map[string]bool{
			"SUMOPOD_SMTP_HOST": smtpHost != "", "SUMOPOD_SMTP_PORT": smtpPortSet, "SUMOPOD_SMTP_USER": smtpUser != "",
			"SUMOPOD_SMTP_PASS": smtpPass != "", "MAIL_FROM": mailFrom != "",
		}, "SUMOPOD_SMTP_HOST", "SUMOPOD_SMTP_PORT", "SUMOPOD_SMTP_USER", "SUMOPOD_SMTP_PASS", "MAIL_FROM")
		requireAll(map[string]bool{
			"DUITKU_MERCHANT_CODE": duitkuMerchant != "", "DUITKU_API_KEY": duitkuKey != "", "DUITKU_CALLBACK_URL": duitkuCallback != "",
		}, "DUITKU_MERCHANT_CODE", "DUITKU_API_KEY", "DUITKU_CALLBACK_URL")
		if duitkuMerchant != "" && dashboard == "" {
			p.fail("DASHBOARD_ORIGIN", false)
		}
		if duitkuEnv == "production" && !prod {
			p.fail("DUITKU_ENV", false)
		}
		requireAll(map[string]bool{
			"SUMOPOD_API_KEY": sumopodKey != "", "SUMOPOD_WEBHOOK_TOKEN": sumopodToken != "", "SUMOPOD_CALLBACK_URL": sumopodCallback != "",
		}, "SUMOPOD_API_KEY", "SUMOPOD_WEBHOOK_TOKEN", "SUMOPOD_CALLBACK_URL")
		if sumopodEnv == "production" && !prod {
			p.fail("SUMOPOD_ENV", false)
		}
		if prod && freeSlots > 0 && smtpHost != "" && turnstile == "" {
			p.fail("TURNSTILE_SECRET_KEY", false)
		}
		if prod && sumopodKey != "" && sumopodSecret == "" {
			p.fail("SUMOPOD_WEBHOOK_SECRET", false)
		}
		duitkuFull, sumopodFull := duitkuMerchant != "", sumopodKey != ""
		if duitkuFull || sumopodFull || sumopodToken != "" {
			if (gateway == "duitku" && !duitkuFull) || (gateway == "sumopod" && !sumopodFull) || (gateway == "both" && (!duitkuFull || !sumopodFull)) {
				p.fail("BILLING_GATEWAY", false)
			}
		}
		if (egress == "enforce" || runtime == "runsc") && (canaryImage == "" || !digestPinned.MatchString(canaryImage)) {
			p.fail("HERMES_CANARY_IMAGE", false)
		}
		dns := resolvers(dnsRaw)
		if runtime == "runsc" && len(dns) == 0 {
			p.fail("HERMES_DNS_RESOLVERS", false)
		}
		for _, ip := range dns {
			if !isIPv4(ip) {
				p.fail("HERMES_DNS_RESOLVERS", false)
			}
		}
	}
	if len(p.keys) > 0 {
		return Config{}, &InvalidError{Keys: p.keys}
	}

	cfg := Config{
		NodeEnv: nodeEnv, DatabaseURL: databaseURL, HermesImage: hermesImage, Port: port, AdminToken: adminToken,
		DockerSocketPath: dockerSocket, MasterKey: masterKey, Runtime: runtime, DiskQuota: diskQuota,
		DiskCheckIntervalMs: diskInterval, EgressPolicy: egress, CanaryImage: canaryImage, CanaryPrivateIP: canaryIP,
		DNSResolvers: resolvers(dnsRaw), SupabaseURL: strings.TrimSuffix(supabase, "/"), DashboardOrigin: dashboard,
		BetaAllowedEmails: lowerList(beta), AdminEmails: lowerList(adminEmails), MaxInstancesPerTenant: maxPerTenant,
		MaxTotalInstances: maxTotal, FreeBetaSlots: freeSlots, PaidCheckoutOpen: paidOpen == "true",
		TurnstileSecret: turnstile, RedisURLIgnored: p.opt("REDIS_URL") != "",
	}
	if corsExtra != "" {
		cfg.CORSExtraOrigins = splitList(corsExtra)
	}
	if opsToken != "" && opsChat != "" {
		cfg.Ops.Telegram = &Telegram{BotToken: opsToken, ChatID: opsChat}
	}
	if kek != "" {
		key, _ := kek32(kek)
		cfg.Secrets = &Secrets{Current: Kek{Version: 1, Key: key}}
		if kekVersionSet {
			cfg.Secrets.Current.Version = kekVersion
		}
		if kekPrev != "" {
			prevKey, _ := kek32(kekPrev)
			prev := Kek{Version: 1, Key: prevKey}
			if kekPrevVersionSet {
				prev.Version = kekPrevVersion
			}
			cfg.Secrets.Previous = &prev
		}
	}
	if smtpHost != "" && smtpPortSet && smtpUser != "" && smtpPass != "" && mailFrom != "" {
		cfg.Mail = &Mail{Host: smtpHost, Port: smtpPort, User: smtpUser, Pass: smtpPass, From: mailFrom}
	}
	if duitkuMerchant != "" || sumopodKey != "" {
		cfg.Billing = &Billing{Gateway: gateway}
		if duitkuMerchant != "" && duitkuKey != "" && duitkuCallback != "" {
			cfg.Billing.Duitku = &Duitku{MerchantCode: duitkuMerchant, APIKey: duitkuKey, Env: duitkuEnv, CallbackURL: duitkuCallback}
		}
		if sumopodKey != "" && sumopodToken != "" && sumopodCallback != "" {
			cfg.Billing.SumoPod = &SumoPod{APIKey: sumopodKey, WebhookToken: sumopodToken, WebhookSecret: sumopodSecret, Env: sumopodEnv, CallbackURL: sumopodCallback}
		}
	}
	if routerKey != "" && routerModel != "" {
		cfg.Router = &Router{APIURL: routerURL, AdminKey: routerKey, DefaultModel: routerModel, EmailDomain: routerDomain}
	}
	return cfg, nil
}
