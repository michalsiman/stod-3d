// 3D Stodsko – samostatný spustitelný soubor.
//
// Obsahuje celý web (složka web/ je zabalená uvnitř) a malé API pro hlášení chyb a změn
// (stejné chování jako tools/server.py). Po spuštění otevře mapu v prohlížeči.
// Hlášení ukládá do složky „stodsko-hlaseni“ vedle spustitelného souboru.
//
// Sestavení: tools/build_exe.sh
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed all:web
var webFS embed.FS

type report struct {
	ID     int      `json:"id"`
	Type   string   `json:"type"`
	Text   string   `json:"text"`
	Name   string   `json:"name"`
	Email  string   `json:"email,omitempty"`
	X      *float64 `json:"x"`
	Z      *float64 `json:"z"`
	Place  string   `json:"place"`
	View   string   `json:"view"`
	Time   string   `json:"time"`
	Status string   `json:"status"`
}

var (
	types    = map[string]bool{"chyba": true, "chybi": true, "zmena": true, "jine": true}
	mu       sync.Mutex
	lastPost = map[string]time.Time{}
	store    string
)

func cut(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func load() []report {
	var items []report
	if b, err := os.ReadFile(store); err == nil {
		_ = json.Unmarshal(b, &items)
	}
	return items
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func reports(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		mu.Lock()
		items := load()
		mu.Unlock()
		out := make([]report, 0, len(items))
		for i := len(items) - 1; i >= 0; i-- {
			it := items[i]
			it.Email = "" // e-maily se nezveřejňují
			out = append(out, it)
		}
		writeJSON(w, 200, out)
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 20000))
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": "neplatná data"})
			return
		}
		var d map[string]any
		if json.Unmarshal(body, &d) != nil {
			writeJSON(w, 400, map[string]string{"error": "neplatná data"})
			return
		}
		str := func(k string) string { s, _ := d[k].(string); return s }
		num := func(k string) *float64 {
			if f, ok := d[k].(float64); ok {
				v := float64(int(f*10)) / 10
				return &v
			}
			return nil
		}
		if str("website") != "" { // honeypot – vyplní jen robot
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		text := cut(str("text"), 2000)
		if utf8.RuneCountInString(text) < 5 {
			writeJSON(w, 400, map[string]string{"error": "Popište prosím problém (aspoň pár slov)."})
			return
		}
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		mu.Lock()
		defer mu.Unlock()
		if t, ok := lastPost[ip]; ok && time.Since(t) < 30*time.Second {
			writeJSON(w, 429, map[string]string{"error": "Chvilku počkejte, než pošlete další hlášení."})
			return
		}
		typ := str("type")
		if !types[typ] {
			typ = "jine"
		}
		items := load()
		id := 1
		for _, it := range items {
			if it.ID >= id {
				id = it.ID + 1
			}
		}
		items = append(items, report{
			ID: id, Type: typ, Text: text, Name: cut(str("name"), 80), Email: cut(str("email"), 120),
			X: num("x"), Z: num("z"), Place: cut(str("place"), 120), View: cut(str("view"), 120),
			Time: time.Now().Format("2006-01-02T15:04:05"), Status: "nové",
		})
		b, _ := json.MarshalIndent(items, "", " ")
		_ = os.MkdirAll(filepath.Dir(store), 0o755)
		tmp := store + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err != nil || os.Rename(tmp, store) != nil {
			writeJSON(w, 500, map[string]string{"error": "Hlášení se nepodařilo uložit."})
			return
		}
		lastPost[ip] = time.Now()
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	default:
		writeJSON(w, 405, map[string]string{"error": "nepodporovaná metoda"})
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func main() {
	port := flag.Int("port", 8765, "port (když je obsazený, zkusí se další)")
	noBrowser := flag.Bool("no-browser", false, "neotevírat prohlížeč")
	public := flag.Bool("public", false, "zpřístupnit i ostatním počítačům v síti")
	flag.Parse()

	exe, _ := os.Executable()
	store = filepath.Join(filepath.Dir(exe), "stodsko-hlaseni", "reports.json")

	sub, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.HandleFunc("/api/reports", reports)
	mux.Handle("/", http.FileServer(http.FS(sub)))

	host := "127.0.0.1"
	if *public {
		host = "0.0.0.0"
	}
	var ln net.Listener
	var err error
	p := *port
	for i := 0; i < 20; i++ {
		if ln, err = net.Listen("tcp", fmt.Sprintf("%s:%d", host, p)); err == nil {
			break
		}
		p++
	}
	if err != nil {
		log.Fatalf("Nepodařilo se otevřít port: %v", err)
	}
	url := fmt.Sprintf("http://localhost:%d/", p)
	fmt.Println("3D Stodsko běží na", url)
	fmt.Println("Hlášení se ukládají do", store)
	fmt.Println("Ukončení: zavřete toto okno nebo stiskněte Ctrl+C.")
	if !*noBrowser {
		go func() { time.Sleep(400 * time.Millisecond); openBrowser(url) }()
	}
	log.Fatal(http.Serve(ln, mux))
}
