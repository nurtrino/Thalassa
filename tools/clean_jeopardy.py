#!/usr/bin/env python3
"""Clean the typed-answer JEOPARDY! deck (data/jeopardy.json) in place.

The deck was scraped from the TV show. A lot of what works on TV does not work
in Thalassa, where the player sees ONLY the category name and the clue text and
has ~15 seconds to TYPE the answer (matched by questions.check_jeopardy). This
script repairs what can be repaired (scraper damage to quotes, HTML entities,
spelled-out answers, ...) and drops what cannot (media/studio clues, board
gimmicks, dated clues, unmatchable answers, duplicates).

    python3 tools/clean_jeopardy.py            # clean data/jeopardy.json in place
    python3 tools/clean_jeopardy.py --dry-run  # just print the summary
    python3 tools/clean_jeopardy.py --show RULE [N]   # print N clues RULE hits

Schema in and out: {"200": [[category, clue, answer], ...], "400": ..., ...}.
Idempotent: every repair is a fixed point and every drop rule is re-applied to
the repaired text, so a second run reports zero changes.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import unicodedata
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.join(HERE, "..", "data", "jeopardy.json")
BANDS = ("200", "400", "800", "1000")

I = re.IGNORECASE


# ════════════════════════════════════════════════════════════════════════════
# REPAIRS — text fixes that keep the clue
# ════════════════════════════════════════════════════════════════════════════

_ENTITY_NOSEMI = re.compile(r"&#(\d{2,5})(?![\d;])")


def fix_text(s: str) -> str:
    """Entities, backslash escapes, odd whitespace, unicode normal form."""
    s = _ENTITY_NOSEMI.sub(r"&#\1;", s)          # '&#8211 perhaps' → entity
    if "&" in s:
        s = html.unescape(s)
    s = s.replace('\\"', '"').replace("\\'", "'").replace("\\", "")
    s = s.replace(" ", " ").replace("​", "")
    s = s.replace("“", '"').replace("”", '"')
    s = s.replace("‘", "'").replace("’", "'")
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"([^\x00-\x7f]);", r"\1", s)       # 'NIÑ;OS' — half-decoded entity
    s = re.sub(r"^\[((?:hi|hello|hey|i'm)\b[^\]]*)\]", r"(\1)", s, flags=I)
    s = re.sub(r"^(\([^)\[]*?) \[([^\]]*)\]", r"\1, \2", s)   # '(Hi, I'm X [in Y])'

    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([,;:!?])", r"\1", s) if not re.search(r"_\s+[,;:!?]", s) else s
    return s


_OPEN_PREV = set(" ([{/-—–")            # a quote after these opens a quotation
_CLOSE_NEXT = set(" ,.;:!?)]}-—–'")     # a quote before these closes one


def _seg_len(s: str) -> int:
    return len(re.sub(r"[^A-Za-z0-9]", "", s))


def fix_quotes(s: str) -> str:
    """The scraper stripped one '"' from the very start and/or very end of
    every field, e.g. `"IN" THE DICTIONARY` → `IN" THE DICTIONARY` and
    `... in "Casino Royale"` → `... in "Casino Royale`. Put them back.
    Inch marks (6'10", 18" long) are not quotation marks and are ignored."""
    inch = {m.end() - 1 for m in re.finditer(
        r"\d+'\d+\"|\d\"(?= ?(long|tall|wide|high|deep|thick|across|in diameter|screen|"
        r"tv|x|by|in (height|length|width|diameter)|of (rain|snow)|or (more|less|longer|taller))\b)",
        s, I)}
    qs = [k for k, ch in enumerate(s) if ch == '"' and k not in inch]
    n = len(qs)
    if n == 0:
        return s
    i, j = qs[0], qs[-1]
    prev = s[i - 1] if i > 0 else " "
    nxt = s[i + 1] if i + 1 < len(s) else " "
    jprev = s[j - 1] if j > 0 else " "
    jnxt = s[j + 1] if j + 1 < len(s) else " "
    first_is_closer = prev not in _OPEN_PREV and (nxt in _CLOSE_NEXT)
    first_midword = prev not in _OPEN_PREV and nxt not in _CLOSE_NEXT
    last_is_opener = jprev in _OPEN_PREV and jnxt not in _CLOSE_NEXT

    if n % 2 == 1:
        if i == 0 and n == 1:                     # lone leading quote
            return s + '"'
        if first_is_closer:
            return '"' + s
        if first_midword and n == 1:
            # 'EV"ERYTHING' vs 'WORD"ZZ': the shorter side is the quoted bit;
            # a bare plural 's' after the quote ('IT"s') is never the quoted bit
            tail = s[i + 1:]
            if tail == "s" or _seg_len(s[:i]) <= _seg_len(tail):
                return '"' + s
            return s + '"'
        if first_midword and i > 0 and " " not in s[:i]:
            # 'SUN"s & "MOON"s' — a quote right after the first word
            return '"' + s
        return s + '"'
    # even count, but both ends were stripped: 'A" & "B'
    if n >= 2 and first_is_closer and last_is_opener and i != j:
        return '"' + s + '"'
    return s


_SPELLED = re.compile(r"^(?:[A-Za-z]-)+[A-Za-z]$")
_PAIR_STOP = {"new", "north", "south", "east", "west", "san", "santa", "st.",
              "saint", "los", "las", "fort", "lake", "mount", "cape", "rhode",
              "el", "la", "le", "de", "port", "great", "little", "big", "old",
              "the", "a", "an", "united", "red", "black", "white", "blue",
              "green", "sir", "dr.", "mr.", "mrs.", "king", "queen", "prince",
              "princess", "lord", "lady", "pope", "saint"}
_NAME_WORD = r"[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)*"
_PAIR = re.compile(rf"^({_NAME_WORD}) ({_NAME_WORD}) (&|and) ({_NAME_WORD}) ({_NAME_WORD})$")


_PEOPLE_CTX = re.compile(r"\b(pair|duo|couple|team|teams|stars|co-?stars|men|women|rivals|"
                         r"candidates|partners|brothers|sisters|husband|wife|married|wed|"
                         r"actors|actresses|singers|leaders|presidents|explorers|people)\b", I)
_SLASH_TITLE = re.compile(r"^[A-Z][A-Za-z]*/[A-Z][A-Za-z]*$")
_SLASH_TITLE_CTX = re.compile(r"\b(band|group|series|show|film|movie|sitcom|album|song)\b", I)


def fix_slash(a: str, clue: str) -> str:
    """'Burma/Myanmar' → 'Burma (Myanmar)', 'flea/flee' → 'flea (flee)',
    'Hog/pig heaven' → 'Hog (pig) heaven'. The matcher accepts the full text
    and the text with (...) removed. Titles like 'AC/DC', 'Nip/Tuck' stay."""
    if "/" not in a or "(" in a or re.search(r"\d/|/\d", a):
        return a
    if _SLASH_TITLE.match(a) and _SLASH_TITLE_CTX.search(clue):
        return a
    parts = [p.strip() for p in a.split("/")]
    if any(not p for p in parts):
        return a
    if " " in parts[0] or len(parts) > 2 or " " not in parts[-1]:
        # whole alternatives: 'Lady Diana Spencer/Princess Diana', 'cent/scent/sent'
        return parts[0] + "".join(f" ({p})" for p in parts[1:])
    # 'Hog/pig heaven': only the first word of the tail is the alternative
    head, tail = parts[1].split(" ", 1)
    return f"{parts[0]} ({head}) {tail}"


def fix_answer(a: str, clue: str = "") -> str:
    a = fix_text(a)
    a = a.strip(' "')
    a = re.sub(r"\.{2,}$", "", a).strip()          # 'Four score and seven....'
    a = re.sub(r"^(an?) (?=\S)", "", a)             # 'a parakeet' → 'parakeet'
    if _SPELLED.match(a):                           # 'K-I-R-S-T-E-N' → 'Kirsten'
        w = a.replace("-", "")
        a = w if not w.isupper() or len(w) <= 4 else w.capitalize()
    a = fix_slash(a, clue)
    m = _PAIR.match(a)
    if (m and m.group(1).lower() not in _PAIR_STOP and m.group(4).lower() not in _PAIR_STOP
            and m.group(1) != m.group(4) and m.group(2) != m.group(5)
            and _PEOPLE_CTX.search(clue)):
        # 'Richard Burton & Elizabeth Taylor' → '(Richard) Burton & (Elizabeth) Taylor'
        # so 'Burton and Taylor' is accepted too (the matcher drops (...) parts)
        a = f"({m.group(1)}) {m.group(2)} {m.group(3)} ({m.group(4)}) {m.group(5)}"
    return a


# ════════════════════════════════════════════════════════════════════════════
# DROP RULES — each returns True when the clue cannot work in the game
# ════════════════════════════════════════════════════════════════════════════

def rx(*parts: str, flags=I) -> re.Pattern:
    return re.compile("|".join(parts), flags)


# ── media / studio ───────────────────────────────────────────────────────────
_LEAD_PAREN = re.compile(r"^\(([^)]*)\)\s*:?\s*(.*)$")
_PRESENTER = rx(r"\b(presents?|delivers?|reads?|gives?|narrates?) (the|a|this) clue\b",
                r"^(hi|hello|hey)\b", r"^i'?m\b", r"^i am\b", r"^[A-Z][\w.' -]+ presents\.?$")
_STAGE = rx(r"\bclue crew\b", r"^alex\b", r"\b(shows?|holds?|points?|demonstrates?|"
            r"stands?|walks?|wears?|wearing|uses?|plays?|indicates?|illustrates?|"
            r"is shown|reports?|presents?|visits?|sits?|stands|dressed|tries|"
            r"runs?|sticks?|undergoes|having|continues|tour|monitor|map|"
            r"photo|video|diagram|board|screen|voice|whispers?|sings?)\b",
            r"\b(Jimmy|Sarah|Kelly|Cheryl|Sofia|Jon|Buzzy|Ken)\b",
            r"^(here we go|last one|watch|look|listen)\b")
MEDIA = rx(
    r"\[[^\]]*\]",                                    # [audio], [Instrumental music plays]
    # 'the following' (a played clip) — unless the text itself follows: 'the following: "Every...'
    r"\bthe following(?!\s*(:\s*)?\"\S)(?! (day|week|month|year|season|spring|summer|fall|"
    r"autumn|winter|morning|night|evening|decade|century|sunday|monday|tuesday|wednesday|"
    r"thursday|friday|saturday|\d|game|race|election|term|march|april|may|june|july|august|"
    r"year's|words?|lines?|quote|passage|verse|letters?|clues?)\b)",
    r"(^|[.!?;:,—] ?|\(|\band )here(?:'s| is| are| we have| you see| we go)\b(?! (a|an|the|one|some) "
    r"(quiz|hint|tip|clue|question|riddle|fact|secret|thought)\b)(?! to\b)"
    r"(?! the (truth|thing|deal|buzz|scoop|story|catch|kicker)\b)",
    r"\b(seen|shown|pictured|depicted|displayed|highlighted|heard|featured|played|"
    r"performed|practiced|demonstrated|illustrated|sounding|sung|crooned|spoken|"
    r"modeled|marked|circled|indicated|labeled|being \w+ed|"
    r"(?!be)\w+ing) (right )?here\b",
    r"\b(right|over) here\b", r"\bhere (in|at|on) (the|this|our|my)\b",
    r"\b(?!(?:founded|born|exiled|originated|buried|located|based|landed|settled|stationed|"
    r"raised|lived|died|married|held|crowned|imprisoned|killed|discovered|invented|built|"
    r"established|opened|started|formed|hosted|staged|filmed|shot|set|named)\b)"
    r"\w+(ed|en)( \w+ly)?( out)? here\b",
    r"\b(one|ones|item|object|thing|quarter|coin|flag|logo|symbol|sign|work|painting|"
    r"image|letters?|word|man|woman|men|guys?|people|person|animal|creature|snake|bird|"
    r"building|statue|structure|device|instrument|tool|hat|picture|event|dish|plant|car) here\b",
    r"\b(?!(?:living|staying|working|coming|going|getting)\b)\w+ing( it| \w+)?( out)? here\b",
    r"\b(worn|by telephoto|on display|in this photo) here\b",
    r"\b(this|these) (photo|photograph|picture|image|clip|footage|map|diagram|animation)s?\b"
    r"(?! (of|for|by|was|that|is named|is called|game|toy|technology)\b)",
    r"\b(shown|seen|pictured|displayed|highlighted|circled) (above|below|at left|at right)\b",
    r"\b(on the|this) (monitor|screen)\b",
    r"\b(here you see|as you can see|you're looking at|you are looking at|"
    r"take a look|look at this|listen to this|behind me|in front of me|"
    r"i'm (holding|wearing|standing|sitting)|i am (holding|wearing))\b",
    r"\b(<[a-z/][^>]*>|https?://|www\.)",
    r"\bclue crew\b", r"\bvideo clue\b",
)


MEDIA_CAT = rx(r"^PICTURE THE\b", r"\bPICTURES (THE|SAY)\b", r"\bVISUALI[SZ]E", r"\bTHROUGH PICTURES\b",
               r"\bCLIP ART\b", r"\bPICTURE ME\b", r"\bTAKE MY PICTURE\b", r"\bVIDEO TOUR\b",
               r"\bWITH SOUND EFFECTS\b", r"\bCLUE CREW\b", r"\bSIGN LANGUAGE\b", r"\bIN SIGN\b",
               r"\bKINDA IN PICTURES\b", r"\bREBUS", r"\bGILBERT PERFORMS\b",
               flags=0)


def is_media(cat: str, clue: str) -> bool:
    if MEDIA_CAT.search(cat):
        return True
    m = _LEAD_PAREN.match(clue)
    if m:
        inner, rest = m.group(1), m.group(2)
        if not rest.strip():
            return True
        if re.match(r"^\d{4}s?$|^\d+ (letters?|words?)|^hint|^\d+ ", inner, I):
            pass                                     # '(1990) ...', '(4 letters) ...'
        elif _PRESENTER.search(inner) and not re.search(r"\bclue crew\b|\bholds?\b|"
                                                        r"\bmonitor\b|\bstanding\b", inner, I):
            pass                                     # celebrity read-out: text stands alone
        elif _STAGE.search(inner):
            return True
        clue = rest
    return bool(MEDIA.search(clue))


# ── board / category gimmicks the category NAME does not convey ─────────────
GIMMICK_CAT = rx(
    r"BEFORE (&|AND) AFTER", r"\bTAKE IN ORDER\b", r"\bIN ORDER\b", r"\bPUT 'EM IN ORDER\b",
    r"\bCATEGORY (ABOVE|BELOW)\b", r"\bPREVIOUS CATEGORY\b", r"\bLAST CATEGORY\b",
    r"\bNEXT CATEGORY\b", r"\bTHIS ROUND\b", r"\bQUASI-?RHYME\b",
    flags=0)
GIMMICK_CLUE = rx(
    r"\b(previous|preceding|last|next|above|below) (\d+ )?(clues?|categor(y|ies)|responses?)\b",
    r"\bclues? (above|below|in this categor)",
    r"\bin this round\b", r"\b(double|final) jeopardy!? (round|categor)",
    r"\bour (contestants|champion|players)\b", r"\bcontestants?[,?!]",
)


# ── dated / time-sensitive ───────────────────────────────────────────────────
DATED_CAT = rx(r"\bRECENT\b", r"(?<!SO-)\bCURRENT\b", r"\bIN THE NEWS\b", r"\bNEWSMAKERS\b",
               r"\bTODAY'S (HITS|MUSIC|NEWS|TV)\b", r"\bOF TODAY\b",
               r"\bNEW IN\b", r"\bTHIS SEASON\b", r"\bWHAT'S NEW\b", r"\bHOT LIST\b",
               r"\bTRENDING\b", r"\bLATEST\b", r"\bNEW ON THE\b", r"\bWHERE ARE THEY NOW\b",
               flags=0)
_SMALL_AGO = re.compile(r"(?<![\d,.])\b(\d[\d,]*|a|one|two|three|four|five|six|seven|eight|nine|ten|"
                        r"a few|several|a couple of) (years?|decades?|months?|weeks?|days?) ago\b", I)
DATED = rx(
    r"\b(?<!the )(?<!his )(?<!her )(?<!its )(?<!their )(?<!of )(?<!a )(?<!one )"
    r"(last|next|this past|this coming) (year|season|month|week|fall|spring|summer|winter|"
    r"autumn|decade|election|olympics)\b",
    r"\b(earlier|later|so far) this (year|month|season|week|decade)\b",
    r"\bthis (season|fall|spring|summer|winter)'s\b", r"\blast year's\b",
    r"\b(currently|presently)\b",
    r"(?<!against )\bthe current\b(?! (penny|nickel|dime|quarter|\$|coin|bill|edition|version|"
    r"cathedral|building|structure|church|volcano|of|medal|purple|flag|design|form)\b)",
    r"\bnow (in|serving) (his|her|its|their) \w+ (year|term|season|decade)",
    r"\b(he|she|they)(?:'s| is| are) now\b", r"\bwho(?:'s| is) now\b",
    r"\bis now (the )?(ceo|president|chairman|head|leader|owner|coach|manager|host|"
    r"anchor|governor|senator|mayor|champion|commissioner|director|secretary)\b",
    r"\b(recently|lately)\b",
    r"\b(in|from) 19\d\d news\b", r"\bat press time\b", r"\bas of (this|now|today)\b",
    r"\bdefending champion\b", r"\bso far\b", r"\bto date\b",
    r"\b(still|yet) to be (decided|determined|announced)\b",
    r"\b(he|she)'s still\b", r"\bis still (alive|living|active|playing|in office)\b",
    r"\bthe (newest|latest|upcoming)\b", r"\b(just|newly) (elected|appointed|crowned)\b",
    r"\b(will|is set to|is scheduled to|plans to|hopes to) (open|debut|premiere|launch|retire|"
    r"take place|be held|be released|be published|be added|be inducted|be the first|be the 1st|"
    r"be 1st|be the last)\b",
)

# "more/most/until recently" are relative, not dated
_DATED_OK = re.compile(r"\b(more|most|until|only|fairly|relatively) recently\b", I)


def is_dated(cat: str, clue: str) -> bool:
    if DATED_CAT.search(cat) and not re.search(r"\d", cat):   # '1940s NEWSMAKERS' is fine
        return True
    c = _DATED_OK.sub("", clue)
    m = _SMALL_AGO.search(re.sub(r'"[^"]*"', '""', c))     # not inside quotations
    if m:
        num = m.group(1)
        if not (num.replace(",", "").isdigit() and int(num.replace(",", "")) >= 300):
            return True
    return bool(DATED.search(c))


# ── answers that cannot be typed / matched ───────────────────────────────────
def bad_answer(cat: str, clue: str, ans: str) -> str | None:
    if not ans or not re.search(r"[A-Za-z0-9]", ans):
        return "empty"
    if re.search(r"(?<!\d)/|/(?!\d)", ans) and not re.fullmatch(r"[A-Z][A-Za-z]*/[A-Z][A-Za-z]*", ans):
        return "unrepaired slash"
    full = re.sub(r"[()]", "", ans)                 # the longest accepted form
    short = re.sub(r"^the ", "", re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", "", ans)).strip(), flags=I)
    if len(short) > 30 or len(short.split()) > 6 or len(full) > 44:
        return "too long to type in time"
    if ans.endswith(("?", "!")) and len(full.split()) >= 4:
        return "sentence"
    if re.search(r"\b(accept|either)\b", ans, I):
        return "alternatives note"
    if ans.count("(") != ans.count(")"):
        return "unbalanced parenthesis"
    return None


# ════════════════════════════════════════════════════════════════════════════
# driver
# ════════════════════════════════════════════════════════════════════════════

NEAR_DUP_JACCARD = 0.7


def _dupe_key(clue: str, ans: str) -> tuple:
    c = re.sub(r"[^a-z0-9]+", " ", clue.lower()).strip()
    a = re.sub(r"[^a-z0-9]+", " ", re.sub(r"\([^)]*\)", "", ans).lower()).strip()
    a = re.sub(r"^(the|a|an) ", "", a)
    return (c, a)


def clean(deck: dict) -> tuple[dict, Counter, dict]:
    stats: Counter = Counter()
    examples: dict[str, list] = {}

    def hit(rule: str, band: str, before, after=None):
        stats[rule] += 1
        examples.setdefault(rule, []).append((band, before, after))

    out: dict[str, list] = OrderedDict()
    seen: set = set()
    near: dict[str, list] = {}           # answer → word sets of kept clues
    for band in BANDS:
        kept = []
        for cell in deck.get(band, []):
            cat0, clue0, ans0 = (str(x) for x in cell)
            cat = fix_quotes(fix_text(cat0))
            clue = fix_quotes(fix_text(clue0))
            ans = fix_answer(ans0, clue)
            if (cat, clue) != (cat0, clue0):
                hit("repair: text (quotes/entities/escapes/whitespace)", band, (cat0, clue0), (cat, clue))
            if ans != ans0:
                hit("repair: answer (article/spelled-out/pair/trim)", band, ans0, ans)

            if not cat or not clue:
                hit("drop: empty field", band, cell); continue
            if is_media(cat, clue):
                hit("drop: media/studio dependent", band, (cat, clue, ans)); continue
            if GIMMICK_CAT.search(cat) or GIMMICK_CLUE.search(clue):
                hit("drop: board/category gimmick", band, (cat, clue, ans)); continue
            if is_dated(cat, clue):
                hit("drop: dated/time-sensitive", band, (cat, clue, ans)); continue
            why = bad_answer(cat, clue, ans)
            if why:
                hit(f"drop: answer {why}", band, (cat, clue, ans)); continue
            if len(clue) < 8:
                hit("drop: clue too short", band, (cat, clue, ans)); continue
            key = _dupe_key(clue, ans)
            if key in seen:
                hit("drop: exact duplicate", band, (cat, clue, ans)); continue
            words = set(key[0].split())
            twins = near.setdefault(key[1], [])
            if any(len(words & w) / len(words | w) >= NEAR_DUP_JACCARD for w in twins):
                hit("drop: near-duplicate (same answer, ≥70% same words)", band, (cat, clue, ans))
                continue
            seen.add(key)
            twins.append(words)
            kept.append([cat, clue, ans])
        out[band] = kept
    return out, stats, examples


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--path", default=DECK)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--show", nargs="+", metavar=("RULE", "N"),
                    help="print examples of a rule (substring match) and exit")
    args = ap.parse_args(argv)

    with open(args.path, encoding="utf-8") as f:
        deck = json.load(f)
    before = {b: len(deck.get(b, [])) for b in BANDS}
    out, stats, examples = clean(deck)

    if args.show:
        want = args.show[0]
        n = int(args.show[1]) if len(args.show) > 1 else 40
        import random
        for rule, ex in examples.items():
            if want in rule:
                print(f"== {rule}: {len(ex)}")
                for e in random.Random(0).sample(ex, min(n, len(ex))):
                    print("  ", e)
        return 0

    print("JEOPARDY! deck cleaner")
    for rule in sorted(stats, key=lambda r: (not r.startswith("repair"), r)):
        print(f"  {rule:<55} {stats[rule]:>6}")
    print("  band     before   after")
    for b in BANDS:
        print(f"  {b:>5}  {before[b]:>7} {len(out[b]):>7}")
    print(f"  total  {sum(before.values()):>7} {sum(len(v) for v in out.values()):>7}")

    if not args.dry_run:
        tmp = args.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, args.path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
