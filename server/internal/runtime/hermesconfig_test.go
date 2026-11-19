package runtime

import (
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

type modelCase struct {
	Name     string  `json:"name"`
	Existing *string `json:"existing"`
	Model    *struct {
		Default, BaseURL, KeyEnv string
	} `json:"model"`
	Output *string `json:"output"`
	Error  string  `json:"error"`
}

func (c modelCase) change() ModelChange {
	if c.Model == nil {
		return ModelChange{Remove: true}
	}
	return ModelChange{Config: ModelConfig{Default: c.Model.Default, BaseURL: c.Model.BaseURL, KeyEnv: c.Model.KeyEnv}}
}

func parseYAML(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := yaml.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return v
}

var commentToken = regexp.MustCompile(`#[^\n]*`)

// TestModelBlockGolden: the same decision as Node for every case, and the same YAML content when written
// (parsed and compared; byte equality is not required, see the plan's Task 4 decision), with every comment of
// the input still present.
func TestModelBlockGolden(t *testing.T) {
	for _, c := range cases[modelCase](t, loadGolden(t), "model") {
		t.Run(c.Name, func(t *testing.T) {
			out, write, err := ApplyModelBlock(c.Existing, c.change())
			if c.Error != "" {
				if !errors.Is(err, apperr.ConfigUnreadable) {
					t.Fatalf("err %v, want config_unreadable", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if c.Output == nil {
				if write {
					t.Fatalf("Node writes nothing here, Go wants to write:\n%s", out)
				}
				return
			}
			if !write {
				t.Fatalf("Node writes here, Go does not")
			}
			if got, want := parseYAML(t, out), parseYAML(t, *c.Output); !reflect.DeepEqual(got, want) {
				t.Fatalf("content differs\n go:\n%s\n node:\n%s", out, *c.Output)
			}
			if c.Existing != nil {
				for _, cm := range commentToken.FindAllString(*c.Existing, -1) {
					if !strings.Contains(out, strings.TrimSpace(cm)) {
						t.Errorf("comment %q lost:\n%s", cm, out)
					}
				}
			}
			if strings.Contains(out, "sk-plain-in-file") {
				t.Error("a literal api_key survived")
			}
		})
	}
}

func TestApplyTwiceWritesOnce(t *testing.T) {
	change := ModelChange{Config: ModelConfig{Default: "gpt-x", BaseURL: "https://llm.example.test/v1", KeyEnv: ProviderKeyEnv}}
	for _, start := range []*string{nil, ptrTo("# notes\nterminal:\n  backend: local # keep\n"), ptrTo("")} {
		out, write, err := ApplyModelBlock(start, change)
		if err != nil || !write {
			t.Fatalf("first apply: %v %v", write, err)
		}
		if out2, write2, err := ApplyModelBlock(&out, change); err != nil || write2 {
			t.Fatalf("second apply must write nothing (write=%v err=%v):\n%s\n---\n%s", write2, err, out, out2)
		}
	}
}

func TestModelBlockKeepsStringTypes(t *testing.T) {
	// Values that look like other YAML types must stay strings.
	change := ModelChange{Config: ModelConfig{Default: "true", BaseURL: "123", KeyEnv: ProviderKeyEnv}}
	out, _, err := ApplyModelBlock(nil, change)
	if err != nil {
		t.Fatal(err)
	}
	m := parseYAML(t, out).(map[string]any)["model"].(map[string]any)
	if m["default"] != "true" || m["base_url"] != "123" {
		t.Fatalf("types changed: %#v\n%s", m, out)
	}
}

func ptrTo(s string) *string { return &s }
