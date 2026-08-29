// Host-side stand-in for the Arduino core, enough to compile and drive the parts
// of Obdurate.ino under test. Only what the extracted functions actually touch.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <deque>
#include <vector>
#include <algorithm>

// Arduino exposes these unqualified via math.h.
using std::isnan;

// ---------------------------------------------------------------- clock
//
// Virtual, not wall-clock: the transport shims advance it, so a test that
// exercises a 400 ms timeout runs instantly and always takes the same path.
extern uint32_t g_millis;
inline uint32_t millis() { return g_millis; }

// ---------------------------------------------------------------- String
//
// Arduino's String, narrowed to the members bleIsoTp() uses.
class String {
 public:
  std::string s;
  String() {}
  String(const char *p) : s(p ? p : "") {}
  String(const std::string &v) : s(v) {}

  unsigned length() const { return (unsigned)s.size(); }
  const char *c_str() const { return s.c_str(); }
  char operator[](unsigned i) const { return i < s.size() ? s[i] : '\0'; }

  String operator+(const String &o) const { return String(s + o.s); }
  String &operator+=(const String &o) { s += o.s; return *this; }
  bool operator==(const char *p) const { return s == p; }

  int indexOf(char c, int from = 0) const {
    if (from < 0 || (size_t)from > s.size()) return -1;
    size_t p = s.find(c, (size_t)from);
    return p == std::string::npos ? -1 : (int)p;
  }
  int indexOf(const char *t, int from = 0) const {
    if (from < 0 || (size_t)from > s.size()) return -1;
    size_t p = s.find(t, (size_t)from);
    return p == std::string::npos ? -1 : (int)p;
  }
  String substring(int from) const {
    if (from < 0) from = 0;
    if ((size_t)from >= s.size()) return String();
    return String(s.substr((size_t)from));
  }
  String substring(int from, int to) const {
    if (from < 0) from = 0;
    if ((size_t)from >= s.size() || to <= from) return String();
    if ((size_t)to > s.size()) to = (int)s.size();
    return String(s.substr((size_t)from, (size_t)(to - from)));
  }
  // Arduino's String::toInt stops at the first non-digit and yields 0 when there is
  // nothing to read, which is what the register parser relies on for a short or
  // empty field. strtol has exactly that behaviour.
  long toInt() const { return strtol(s.c_str(), nullptr, 10); }
  bool startsWith(const char *p) const { return s.rfind(p, 0) == 0; }
  bool startsWith(const String &p) const { return s.rfind(p.s, 0) == 0; }
  void replace(const char *from, const char *to) {
    std::string f(from), t(to);
    if (f.empty()) return;
    for (size_t p = s.find(f); p != std::string::npos; p = s.find(f, p + t.size()))
      s.replace(p, f.size(), t);
  }
  void trim() {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    s = (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
  }
  void remove(unsigned from, unsigned count) {
    if (from < s.size()) s.erase(from, count);
  }
};

// ---------------------------------------------------------------- misc
inline void delay(uint32_t ms) { g_millis += ms; }

// Arduino defines these as macros, and canIsoTp() relies on macro semantics with
// mixed size_t expressions. Defined last so the std:: headers above are unaffected.
#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) > (b) ? (a) : (b))
