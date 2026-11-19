package runtime

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"testing"
)

// golden is testdata/golden/runtime.golden.json, made by gen/runtime.ts from the Node runtime code.
type golden map[string]json.RawMessage

func loadGolden(t *testing.T) golden {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "runtime.golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

// cases decodes one golden array into a slice of T.
func cases[T any](t *testing.T, g golden, key string) []T {
	t.Helper()
	raw, ok := g[key]
	if !ok {
		t.Fatalf("golden has no %q", key)
	}
	var out []T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("golden %q: %v", key, err)
	}
	if len(out) == 0 {
		t.Fatalf("golden %q is empty", key)
	}
	return out
}

// assertEngineEqual is the "same Docker request as Node" rule:
//  1. every key and value Node sent exists with an equal value in Go's JSON, except that a Node value that is
//     empty ("", 0, {}, []) may be absent in Go; false is significant and must be present (Init, EnableIPv6);
//  2. every key Go sends that Node did not send holds a zero value;
//  3. Env is compared as a set (Go builds it from a map).
func assertEngineEqual(t *testing.T, node map[string]any, goValue any) {
	t.Helper()
	b, err := json.Marshal(goValue)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	var problems []string
	compareObj("", node, got, &problems)
	if len(problems) > 0 {
		nb, _ := json.MarshalIndent(node, "", "  ")
		t.Fatalf("Docker request differs from Node:\n  %s\nnode: %s\ngo:   %s", joinLines(problems), nb, b)
	}
}

func joinLines(s []string) string {
	sort.Strings(s)
	out := ""
	for i, l := range s {
		if i > 0 {
			out += "\n  "
		}
		out += l
	}
	return out
}

func isZero(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case bool:
		return !x
	case float64:
		return x == 0
	case string:
		return x == ""
	case []any:
		for _, e := range x {
			if !isZero(e) {
				return false
			}
		}
		return true
	case map[string]any:
		for _, e := range x {
			if !isZero(e) {
				return false
			}
		}
		return true
	}
	return false
}

// absentMeansFalse lists the Engine fields the SDK omits when false (omitempty) and whose Engine default is false,
// so an absent key means the same as Node's explicit false. Init and EnableIPv6 are not here on purpose: their
// daemon defaults can be true.
var absentMeansFalse = map[string]bool{"NoCopy": true, "NetworkDisabled": true}

// isEmpty is a Node value Go may leave out: empty but not false.
func isEmpty(v any) bool {
	if b, ok := v.(bool); ok {
		return b // never: false must be sent explicitly
	}
	return isZero(v)
}

func compareObj(path string, node, got map[string]any, problems *[]string) {
	for k, nv := range node {
		p := path + "." + k
		gv, ok := got[k]
		if !ok {
			if nv == false && absentMeansFalse[k] {
				continue
			}
			if !isEmpty(nv) {
				*problems = append(*problems, fmt.Sprintf("%s: missing in Go (node %v)", p, nv))
			}
			continue
		}
		compareVal(p, nv, gv, problems)
	}
	for k, gv := range got {
		if _, ok := node[k]; !ok && !isZero(gv) {
			*problems = append(*problems, fmt.Sprintf("%s.%s: extra in Go: %v", path, k, gv))
		}
	}
}

func compareVal(p string, nv, gv any, problems *[]string) {
	if nm, ok := nv.(map[string]any); ok {
		if gm, ok := gv.(map[string]any); ok {
			compareObj(p, nm, gm, problems)
			return
		}
		if isEmpty(nv) && isZero(gv) {
			return
		}
		*problems = append(*problems, fmt.Sprintf("%s: node object %v, go %v", p, nv, gv))
		return
	}
	if p == ".Env" {
		nl, gl := toStrings(nv), toStrings(gv)
		slices.Sort(nl)
		slices.Sort(gl)
		if !slices.Equal(nl, gl) {
			*problems = append(*problems, fmt.Sprintf("%s: node %v, go %v", p, nl, gl))
		}
		return
	}
	if na, ok := nv.([]any); ok {
		ga, ok := gv.([]any)
		if !ok && isEmpty(nv) && isZero(gv) {
			return
		}
		if !ok || len(na) != len(ga) {
			*problems = append(*problems, fmt.Sprintf("%s: node %v, go %v", p, nv, gv))
			return
		}
		for i := range na {
			compareVal(fmt.Sprintf("%s[%d]", p, i), na[i], ga[i], problems)
		}
		return
	}
	if !reflect.DeepEqual(nv, gv) {
		*problems = append(*problems, fmt.Sprintf("%s: node %v, go %v", p, nv, gv))
	}
}

func toStrings(v any) []string {
	a, _ := v.([]any)
	out := make([]string, 0, len(a))
	for _, e := range a {
		out = append(out, fmt.Sprint(e))
	}
	return out
}

// TestEngineRuleCatchesDifferences: the comparison is not blind.
func TestEngineRuleCatchesDifferences(t *testing.T) {
	node := map[string]any{"Init": false, "Memory": float64(5), "Labels": map[string]any{}}
	for name, goValue := range map[string]any{
		"missing false":  map[string]any{"Memory": 5},
		"wrong number":   map[string]any{"Init": false, "Memory": 6},
		"extra non-zero": map[string]any{"Init": false, "Memory": 5, "Privileged": true},
	} {
		var problems []string
		b, _ := json.Marshal(goValue)
		var got map[string]any
		_ = json.Unmarshal(b, &got)
		compareObj("", node, got, &problems)
		if len(problems) == 0 {
			t.Errorf("%s: no difference found", name)
		}
	}
	var problems []string
	compareObj("", node, map[string]any{"Init": false, "Memory": float64(5)}, &problems)
	if len(problems) != 0 {
		t.Errorf("an absent empty map must be accepted: %v", problems)
	}
}
