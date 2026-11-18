package db

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Test helpers for TestUpdatesSetUpdatedAt. They read text only: no database needed.

var (
	tableLine  = regexp.MustCompile(`^table (\S+) `)
	updateStmt = regexp.MustCompile(`(?is)^\s*UPDATE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?`)
	queryName  = regexp.MustCompile(`--\s*name:\s*(\S+)`)
)

// TablesWithColumn lists the tables in a schemadump golden that have the given column.
func TablesWithColumn(goldenPath, column string) (map[string]bool, error) {
	f, err := os.Open(goldenPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := map[string]bool{}
	current := ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if m := tableLine.FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		if current != "" && strings.HasPrefix(strings.TrimSpace(line), "column "+column+" ") {
			out[current] = true
		}
	}
	return out, sc.Err()
}

// UpdatesMissingColumn returns "<file>: <query name>" for every UPDATE statement in dir/*.sql that targets
// one of tables and does not mention the column (quoted).
func UpdatesMissingColumn(dir string, tables map[string]bool, column string) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		return nil, err
	}
	var bad []string
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		name := "?"
		for _, stmt := range strings.Split(string(b), ";") {
			if m := queryName.FindAllStringSubmatch(stmt, -1); m != nil {
				name = m[len(m)-1][1]
			}
			body := stripComments(stmt)
			m := updateStmt.FindStringSubmatch(body)
			if m == nil || !tables[m[1]] {
				continue
			}
			if !strings.Contains(body, `"`+column+`"`) {
				bad = append(bad, filepath.Base(file)+": "+name)
			}
		}
	}
	return bad, nil
}

func stripComments(s string) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "--") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}
