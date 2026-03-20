#!/usr/bin/env python3
import argparse, os, re, sys, csv
from decimal import Decimal
from datetime import datetime
from io import StringIO

try:
    from pdfminer.high_level import extract_text_to_fp
    from pdfminer.layout import LAParams
except Exception:
    extract_text_to_fp = None
    LAParams = None

CONFIG_FOLDER = os.path.join(os.path.dirname(__file__), "Config")
os.makedirs(CONFIG_FOLDER, exist_ok=True)
IGNORE_FILE = os.path.join(CONFIG_FOLDER, "ignores.txt")

CSV_HEADER = ["Date", "ID", "Tag", "Name", "Amount", "Type", "Category", "Source"]

MONTHS = {'JAN':1,'FEB':2,'MAR':3,'APR':4,'MAY':5,'JUN':6,'JUL':7,'AUG':8,'SEP':9,'SEPT':9,'OCT':10,'NOV':11,'DEC':12}

# ---------- Regexes ----------
STMT_RANGE_RE = re.compile(
    r"STATEMENT\s+FROM\s+([A-Za-z]{3,9})\s*[, ]?\s*(\d{1,2}),\s*(\d{4})\s*TO\s*([A-Za-z]{3,9})\s*[, ]?\s*(\d{1,2}),\s*(\d{4})",
    re.IGNORECASE
)

# Two date tokens (DEC03DEC04 or DEC 03 DEC 04)
DATE2 = r"(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s?(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s?(\d{1,2})"

# Require dollar sign for amounts; support -$12.34 and ($12.34)
AMT_TOKEN = r"((?:-\s*)?\$\s*[\d,]+\.\d{2}|\(\$\s*[\d,]+\.\d{2}\))"

# One-pass: dates → (lazy) description → FIRST $amount
TX_ANY_RE = re.compile(
    DATE2 + r"(.*?)" + AMT_TOKEN,
    re.IGNORECASE | re.DOTALL
)

# Boilerplate tails to strip from description
FOREX_TAIL_RE = re.compile(r"ForeignCurrency-.*?Exchangerate-.*?(?=$|\$)", re.IGNORECASE)
HEADER_NOISE_RE = re.compile(r"TRANSACTIONPOSTINGACTIVITYDESCRIPTIONAMOUNT\(\$\)DATEDATE", re.IGNORECASE)

PROV_TAIL = r"(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU)"

# ---------- Ignore helpers ----------
def load_ignore_patterns():
    pats = []
    try:
        if os.path.isfile(IGNORE_FILE):
            with open(IGNORE_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    s = line.strip()
                    if not s or s.startswith("#"):
                        continue
                    pats.append(s.lower())
    except Exception as e:
        print(f"[warn] Failed reading ignores file: {e}", file=sys.stderr)
    return pats

def should_ignore_tx(tx, patterns):
    tag  = (tx.get("Tag")  or "").lower()
    name = (tx.get("Name") or "").lower()
    return any(p in tag or p in name for p in patterns)

# ---------- PDF text ----------
def extract_text_custom(pdf_path):
    if extract_text_to_fp is None:
        raise RuntimeError("pdfminer.six is required. pip install pdfminer.six")
    lp = LAParams(
        line_margin=0.12,
        char_margin=2.0,   # keeps DEC03 as one token; glues merchant+ID
        word_margin=0.1,
        boxes_flow=None
    )
    out = StringIO()
    with open(pdf_path, "rb") as fp:
        extract_text_to_fp(fp, out, laparams=lp)
    return out.getvalue()

def normalize(s: str) -> str:
    s = s.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")
    s = s.replace("\xa0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()

# ---------- Date helpers ----------
def infer_stmt_end_ym(text):
    m = STMT_RANGE_RE.search(text)
    if not m:
        t = datetime.today()
        return t.year, t.month
    _, _, _, mon2, _day2, year2 = m.groups()
    mon = MONTHS.get(mon2[:4].upper().replace("SEPT","SEP"), None)
    return (int(year2), mon or datetime.today().month)

def year_for_tx(stmt_end_year, stmt_end_mon, tx_mon):
    if stmt_end_mon == 1 and tx_mon == 12:
        return stmt_end_year - 1
    if tx_mon > stmt_end_mon:
        return stmt_end_year - 1
    return stmt_end_year

# ---------- Description / amount / id helpers ----------
def parse_amount_token(tok: str):
    """returns (Decimal value, is_credit_like) where credit-like means negative or parentheses."""
    tok = tok.strip()
    neg = False
    if tok.startswith("(") and tok.endswith(")"):
        neg = True
        tok = tok[1:-1]
    tok = tok.replace("$", "").replace(",", "")
    if tok.startswith("-"):
        neg = True
        tok = tok[1:]
    return Decimal(tok), neg

def clean_desc(desc):
    desc = HEADER_NOISE_RE.sub("", desc)
    desc = FOREX_TAIL_RE.sub("", desc)
    return normalize(desc)

def extract_id_and_tag(desc_raw: str):
    """Find last 14–32 digit run before the amount as ID (if any), remove it from tag."""
    # last long digit run
    m = re.search(r"(\d{14,32})(?!.*\d{14,32})", desc_raw)
    tx_id = "0"
    if m:
        tx_id = m.group(1)
        # drop that id from the tag text
        desc_raw = (desc_raw[:m.start()] + " " + desc_raw[m.end():]).strip()
    tag = clean_desc(desc_raw)
    tag = prettify_tag(tag)
    return tx_id, tag

def prettify_tag(tag: str) -> str:
    """Light-touch spacing so outputs look closer to your desired format."""
    if not tag:
        return tag

    # space around separators
    tag = re.sub(r"([#/*])", r" \1 ", tag)
    # split letter<->digit boundaries
    tag = re.sub(r"([A-Za-z])(\d)", r"\1 \2", tag)
    tag = re.sub(r"(\d)([A-Za-z])", r"\1 \2", tag)
    # add space before trailing province
    tag = re.sub(rf"(.*?){PROV_TAIL}$", r"\1 \2", tag)
    # fix domains like WWW.AMAZON.CAON -> WWW.AMAZON.CA ON
    tag = re.sub(rf"([A-Z0-9]+\.[A-Z0-9]+){PROV_TAIL}\b", r"\1 \2", tag, flags=re.IGNORECASE)

    tag = re.sub(r"\s{2,}", " ", tag).strip()
    return tag

CREDIT_KEYWORDS = (
    "PAYMENT", "REFUND", "REVERSAL", "RETURN", "ADJUST", "CREDIT",
    "ROYALBANK",  # RBC ROYAL BANK postings
)

# ---------- Parser ----------
def parse_transactions(raw_text, debug=False):
    text = normalize(raw_text)

    end_year, end_mon = infer_stmt_end_ym(text)
    txs = []

    for m in TX_ANY_RE.finditer(text):
        mon1, d1, mon2, d2 = m.group(1), m.group(2), m.group(3), m.group(4)
        desc_raw = m.group(5) or ""
        amt_tok  = m.group(6) or ""

        mon_abbr = mon1[:4].upper().replace("SEPT","SEP")
        tx_mon = MONTHS.get(mon_abbr, None)
        if not tx_mon:
            continue
        year = year_for_tx(end_year, end_mon, tx_mon)
        date_iso = f"{year:04d}-{tx_mon:02d}-{int(d1):02d}"

        amount, credit_like = parse_amount_token(amt_tok)
        # Pull ID out of the description segment BEFORE this first $ amount
        tx_id, tag = extract_id_and_tag(desc_raw)

        # Classify income/expense
        tag_uc_nospace = re.sub(r"\s+", "", tag.upper())
        is_income = credit_like or any(k in tag_uc_nospace for k in CREDIT_KEYWORDS)
        tx_type = "Income" if is_income else "Expense"

        txs.append({
            "Date": date_iso,
            "ID": tx_id,
            "Tag": tag,
            "Name": "N/A",
            "Amount": f"{amount:.2f}",
            "Type": tx_type,
            "Category": "N/A",
            "Source": None
        })

    # Sort for stable output
    txs.sort(key=lambda r: (r["Date"], r["Tag"], r["ID"]))

    if debug:
        print(f"[debug] parsed {len(txs)} transactions", file=sys.stderr)

    return txs

# ---------- CSV ----------
def write_csv(rows, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_HEADER)
        for r in rows:
            w.writerow([r[c] for c in CSV_HEADER])

# ---------- Main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", help="Path to PDF")
    ap.add_argument("--source", choices=["CREDIT","DEBIT"], default="DEBIT")
    ap.add_argument("--save", action="store_true", help="Save to Credit/ or Debit/")
    ap.add_argument("--outname", default=None, help="Optional output filename")
    ap.add_argument("--read", action="store_true", help="Print CSV to stdout")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    text = extract_text_custom(args.pdf)
    txs = parse_transactions(text, debug=args.debug)

    # attach source + ignores
    ignores = load_ignore_patterns()
    for t in txs: t["Source"] = args.source
    txs = [t for t in txs if not should_ignore_tx(t, ignores)]

    # output
    if args.read or not args.save:
        w = csv.writer(sys.stdout)
        w.writerow(CSV_HEADER)
        for r in txs:
            w.writerow([r[c] for c in CSV_HEADER])

    if args.save:
        base = os.path.dirname(os.path.abspath(__file__))
        out_dir = os.path.join(base, "Credit" if args.source=="CREDIT" else "Debit")
        os.makedirs(out_dir, exist_ok=True)
        out_name = args.outname or f"{os.path.splitext(os.path.basename(args.pdf))[0]}.csv"
        write_csv(txs, os.path.join(out_dir, out_name))

if __name__ == "__main__":
    main()
