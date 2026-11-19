package runtime

import (
	"bytes"
	"reflect"

	"go.yaml.in/yaml/v3"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

// ProviderKeyEnv is the environment variable that carries the provider key; the file only ever names it.
const ProviderKeyEnv = "HERMES_PROVIDER_API_KEY"

// ApplyModelBlock computes the new /opt/data/config.yaml with the platform-managed model block (ADR 0003). Port
// of hermes-config.ts: every other key and comment is kept; with Remove the block goes only if the platform wrote
// it (its key_env is ProviderKeyEnv); sessions.auto_prune is set to true once and a value already there is never
// changed. write is false when the content would not change. A file that is not YAML or whose top level is not a
// map is refused with apperr.ConfigUnreadable and left untouched.
func ApplyModelBlock(existing *string, change ModelChange) (out string, write bool, err error) {
	if existing == nil && change.Remove {
		return "", false, nil
	}
	var doc yaml.Node
	if existing != nil {
		if err := yaml.Unmarshal([]byte(*existing), &doc); err != nil {
			return "", false, apperr.ConfigUnreadable
		}
	}
	root, ok := rootMap(&doc)
	if !ok {
		return "", false, apperr.ConfigUnreadable
	}

	if change.Remove {
		if block := mapGet(root, "model"); block != nil && block.Kind == yaml.MappingNode {
			if ke := mapGet(block, "key_env"); ke != nil && ke.Kind == yaml.ScalarNode && ke.Value == ProviderKeyEnv {
				mapDelete(root, "model")
			}
		}
	} else {
		block := mapGet(root, "model")
		if block == nil || block.Kind != yaml.MappingNode {
			block = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			mapSet(root, "model", block)
		}
		m := change.Config
		mapDelete(block, "api_key")
		mapSet(block, "default", str(m.Default))
		mapSet(block, "provider", str("custom"))
		mapSet(block, "base_url", str(m.BaseURL))
		mapSet(block, "key_env", str(m.KeyEnv))
	}
	// Hermes asks about auto-prune straight in the customer's chat when its disk looks small; the platform answers
	// once (owner decision, 2026-11-17). A sessions key that is not a map is left alone.
	switch sessions := mapGet(root, "sessions"); {
	case sessions == nil:
		s := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		mapSet(s, "auto_prune", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
		mapSet(root, "sessions", s)
	case sessions.Kind == yaml.MappingNode && mapGet(sessions, "auto_prune") == nil:
		mapSet(sessions, "auto_prune", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return "", false, apperr.ConfigUnreadable
	}
	if err := enc.Close(); err != nil {
		return "", false, apperr.ConfigUnreadable
	}
	out = buf.String()
	if existing != nil && sameContent(*existing, out) {
		return "", false, nil
	}
	return out, true, nil
}

// rootMap returns the document's top-level map, turning an empty (or comment-only) document into one.
func rootMap(doc *yaml.Node) (*yaml.Node, bool) {
	empty := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	switch {
	case doc.Kind == 0:
		*doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{empty}}
		return empty, true
	case doc.Kind == yaml.DocumentNode && len(doc.Content) == 0:
		doc.Content = []*yaml.Node{empty}
		return empty, true
	case doc.Kind == yaml.DocumentNode && doc.Content[0].Kind == yaml.MappingNode:
		return doc.Content[0], true
	}
	return nil, false
}

func str(v string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v} }

func mapIndex(m *yaml.Node, key string) int {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Kind == yaml.ScalarNode && m.Content[i].Value == key {
			return i
		}
	}
	return -1
}

func mapGet(m *yaml.Node, key string) *yaml.Node {
	if i := mapIndex(m, key); i >= 0 {
		return m.Content[i+1]
	}
	return nil
}

// mapSet replaces the value in place (the key keeps its position and comments) or appends the pair.
func mapSet(m *yaml.Node, key string, val *yaml.Node) {
	if i := mapIndex(m, key); i >= 0 {
		old := m.Content[i+1]
		val.LineComment, val.FootComment = old.LineComment, old.FootComment
		m.Content[i+1] = val
		return
	}
	m.Content = append(m.Content, str(key), val)
}

func mapDelete(m *yaml.Node, key string) {
	if i := mapIndex(m, key); i >= 0 {
		m.Content = append(m.Content[:i], m.Content[i+2:]...)
	}
}

// sameContent reports whether two YAML texts hold the same data (comments and layout aside).
func sameContent(a, b string) bool {
	var x, y any
	if yaml.Unmarshal([]byte(a), &x) != nil || yaml.Unmarshal([]byte(b), &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
