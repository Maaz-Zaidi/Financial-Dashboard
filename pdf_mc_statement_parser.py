#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pdf_mc_statement_parser.py

Parse an RBC Mastercard statement PDF into CSV rows with fields:
["Date", "ID", "Tag", "Name", "Amount", "Type", "Category", "Source"]

- Date: YYYY-MM-DD (uses the first "transaction date" from each line)
- ID: the long numeric string printed under the tag/description; "0" if missing
- Tag: full merchant/description text
- Name: "N/A" (placeholder for now)
- Amount: signed numeric value as found in the PDF (e.g., -26.48)
- Type: "Income" if it's a credit/refund/payment; else "Expense"
- Category: "N/A" (placeholder)
- Source: "DEBIT" (default) or "CREDIT" (configurable via CLI or function)

Also supports an ignore list at:
  CONFIG_FOLDER/ignores.txt
Each non-empty, non-comment line is a case-insensitive substring.
If a transaction's Tag or Name contains any pattern, that transaction is skipped.

USAGE (CLI):
    python pdf_mc_statement_parser.py "/path/to/statement.pdf" \
        --source CREDIT --save --outdir .

    # Print parsed rows to STDOUT (for piping into another tool):
    python pdf_mc_statement_parser.py "/path/to/statement.pdf" --read --format csv

    # Same but JSON:
    python pdf_mc_statement_parser.py "/path/to/statement.pdf" --read --format json

PROGRAMMATIC USE:
    from pdf_mc_statement_parser import extract_transactions
    rows = extract_transactions(pdf_path, source="CREDIT", include_header=True)

Notes:
- The parser uses a tiny "formal language" (tokenizer + recursive-descent parser)
  tailored to the typical RBC statement layout.
- It extracts the statement date range header to infer the year for each month/day.
- It is robust to lines like "AUTOMATIC PAYMENT -THANK YOU -$1,152.66" that
  include the amount on the same line as the description and omit an ID line.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable, List, Optional, Tuple, Dict, Any

# ----------------------------- Configuration -----------------------------

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FOLDER = BASE_DIR / "config"
CONFIG_FOLDER.mkdir(parents=True, exist_ok=True)
IGNORE_FILE = CONFIG_FOLDER / "ignores.txt"
LOG_FILE = CONFIG_FOLDER / "parser.log"


def normalize_pdf_text(raw: str) -> str:
    """
    Normalize PDF-extracted text that may lack spaces or use weird minus glyphs.
    - Collapse whitespace
    - Fix common minus encodings like "U-$" -> "-$"
    - Remove soft hyphen and NBSP variants
    """
    s = raw.replace("\u00ad", "").replace("\u00a0", " ")
    s = re.sub(r"\s+", " ", s)
    # Common encoding quirk seen in RBC PDFs: "U-$" appears for negatives
    s = s.replace("U-$", "-$").replace("−$", "-$").replace("–$", "-$")
    return s

HEADER_PERIOD_NOSP_RE = re.compile(
    r"STATEMENT\s*FROM\s*(?P<sm>[A-Z]{3})\s*(?P<sd>\d{2}),\s*(?P<sy>\d{4})\s*TO\s*(?P<em>[A-Z]{3})\s*(?P<ed>\d{2}),\s*(?P<ey>\d{4})",
    re.IGNORECASE
)
# ------------------------------ Utilities --------------------------------

MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12
}

AMOUNT_PATTERN = re.compile(
    r"(?P<sign>-)?\s*\$?\s*(?P<num>\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+(?:\.\d{2}))\b"
)

LONG_ID_PATTERN = re.compile(r"^\s*(\d{14,})\s*$")

# Transaction "income" hints. Extend as needed.
INCOME_KEYWORDS = (
    "AUTOMATIC PAYMENT",  # payment to card
    "REFUND",
    "REWARD",
    "REVERSAL",
    "RBC ROYAL BANK",     # user expects this as income in sample output
)

EXPENSE_KEYWORDS = (
    "CASH ADVANCE INTEREST",
)

def log_change(msg: str) -> None:
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(msg.rstrip() + "\n")
    except Exception:
        # As a last resort, print to stderr
        print(msg, file=sys.stderr)


def clean_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def parse_amount(text: str) -> Optional[float]:
    """
    Extract the *last* monetary amount in the given text. Returns signed float.
    Accepts formats like "$12.34", "-$12.34", "12.34", "1,152.66".
    """
    matches = list(AMOUNT_PATTERN.finditer(text))
    if not matches:
        return None
    m = matches[-1]
    num = m.group("num").replace(",", "")
    sign = -1.0 if m.group("sign") else 1.0
    try:
        return float(num) * sign
    except ValueError:
        return None


def number_to_year(month_abbrev: str, start_mon: int, start_year: int, end_year: int) -> int:
    """
    Given a month abbreviation for a transaction, and the statement range
    start month/year and end year, infer the correct year. If the transaction
    month number is less than the statement start month number, it belongs to
    the end year (handles year wrap-around like DEC -> JAN).
    """
    mnum = MONTHS[month_abbrev]
    return end_year if mnum < start_mon else start_year


def normalize_date(month_abbrev: str, day_str: str, start_mon: int, start_year: int, end_year: int) -> str:
    yyyy = number_to_year(month_abbrev, start_mon, start_year, end_year)
    mm = MONTHS[month_abbrev]
    dd = int(day_str)
    return f"{yyyy:04d}-{mm:02d}-{dd:02d}"


# ------------------------------ Ignoring ---------------------------------

def load_ignore_patterns() -> List[str]:
    patterns: List[str] = []
    try:
        if os.path.isfile(IGNORE_FILE):
            with open(IGNORE_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    s = line.strip()
                    if not s or s.startswith('#'):
                        continue
                    patterns.append(s.lower())
    except Exception as e:
        log_change(f"Failed reading ignores file: {e}")
    return patterns


def should_ignore_tx(tx: Dict[str, Any], patterns: List[str]) -> bool:
    tag = (tx.get("Tag") or "").lower()
    name = (tx.get("Name") or "").lower()
    for p in patterns:
        if p in tag or p in name:
            return True
    return False


# ---------------------------- PDF Extraction -----------------------------

def extract_pdf_text(pdf_path: Path) -> str:
    """
    Extract text from a PDF, preferring pdfminer.six, falling back to PyPDF2.
    """
    # Try pdfminer.six
    try:
        from pdfminer.high_level import extract_text  # type: ignore
        return normalize_pdf_text(extract_text(str(pdf_path)))
    except Exception as e:
        log_change(f"pdfminer failed ({e}); trying PyPDF2...")
    # Fallback: PyPDF2
    try:
        import PyPDF2  # type: ignore
        text_parts = []
        with open(pdf_path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            for page in reader.pages:
                text_parts.append(page.extract_text() or "")
        return normalize_pdf_text("\n".join(text_parts))
    except Exception as e:
        raise RuntimeError(f"Failed to extract text from PDF: {e}")


# ------------------------------ Tokenizer --------------------------------

@dataclass
class Token:
    kind: str
    value: str
    line_no: int


DATE_LINE_RE = re.compile(
    r"^\s*(?P<m1>JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+"
    r"(?P<d1>\d{2})\s+"
    r"(?P<m2>JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+"
    r"(?P<d2>\d{2})\s+"
    r"(?P<desc>.*?)\s*$",
    re.IGNORECASE
)

HEADER_PERIOD_RE = re.compile(
    r"STATEMENT\s+FROM\s+(?P<sm>\w{3})\s+(?P<sd>\d{2}),\s+(?P<sy>\d{4})\s+"
    r"TO\s+(?P<em>\w{3})\s+(?P<ed>\d{2}),\s+(?P<ey>\d{4})",
    re.IGNORECASE
)

def tokenize(text: str) -> Tuple[List[Token], Tuple[int, int, int]]:
    """
    Convert the PDF text into a stream of tokens.
    Returns (tokens, (start_mon, start_year, end_year)).
    """
    tokens: List[Token] = []
    start_mon = start_year = end_year = None  # type: ignore

    lines = text.splitlines()
    for i, raw in enumerate(lines, start=1):
        line = clean_spaces(raw)

        # extract statement period once
        if start_mon is None:
            m = HEADER_PERIOD_RE.search(line)
            if m:
                sm = m.group("sm").upper()[:3]
                sy = int(m.group("sy"))
                ey = int(m.group("ey"))
                start_mon = MONTHS.get(sm, 1)
                start_year = sy
                end_year = ey

        if not line:
            continue

        # Date line with description (may include amount)
        dm = DATE_LINE_RE.match(line.upper())
        if dm:
            tokens.append(Token("DATE_PAIR", f"{dm.group('m1')},{dm.group('d1')}", i))
            tokens.append(Token("POST_DATE", f"{dm.group('m2')},{dm.group('d2')}", i))
            desc = clean_spaces(dm.group("desc"))
            if desc:
                tokens.append(Token("DESC", desc, i))
            # If there's an amount on this same line, capture as AMOUNT token too.
            amt = parse_amount(line)
            if amt is not None:
                tokens.append(Token("AMOUNT_INLINE", str(amt), i))
            continue

        # Pure long numeric ID line
        nid = LONG_ID_PATTERN.match(line)
        if nid:
            tokens.append(Token("ID", nid.group(1), i))
            continue

        # Standalone amount line like "$4.51" or "-$26.48"
        if AMOUNT_PATTERN.fullmatch(line):
            amt2 = parse_amount(line)
            if amt2 is not None:
                tokens.append(Token("AMOUNT", str(amt2), i))
            continue

        # Non-empty, non-matching lines might carry extra info (e.g., foreign currency).
        # We keep them in DESC_EXTRA; parser can ignore them or use as needed.
        tokens.append(Token("TEXT", line, i))

    if start_mon is None or start_year is None or end_year is None:
        # Fail gracefully if header not found; default to current year to avoid crashing.
        today = date.today()
        start_mon = start_mon or today.month
        start_year = start_year or today.year
        end_year = end_year or today.year

    return tokens, (start_mon, start_year, end_year)


# ------------------------------- Parser ----------------------------------


def classify_type(desc: str, amount: float) -> str:
    # Normalize: remove spaces for robust matching against PDFs without spaces
    u = re.sub(r'\s+', '', desc.upper())
    income_keys = set([
        "AUTOMATICPAYMENT", "REFUND", "REWARD", "REVERSAL",
        "RBCROYALBANK"
    ])
    expense_keys = set([
        "CASHADVANCEINTEREST"
    ])
    if any(k in u for k in income_keys):
        return "Income"
    if any(k in u for k in expense_keys):
        return "Expense"
    return "Income" if amount < 0 else "Expense"


def parse_transactions(tokens: List[Token], period: Tuple[int, int, int], source: str) -> List[Dict[str, Any]]:
    """
    A simple recursive-descent parser that reads sequences of:
        DATE_PAIR POST_DATE DESC [ID]? [AMOUNT_INLINE or AMOUNT]? [TEXT*]? [AMOUNT]?
    and yields transactions.
    """
    start_mon, start_year, end_year = period
    i = 0
    n = len(tokens)
    out: List[Dict[str, Any]] = []

    def peek(kinds: Iterable[str]) -> Optional[Token]:
        nonlocal i
        if i < n and tokens[i].kind in kinds:
            return tokens[i]
        return None

    def take(kind: str) -> Optional[Token]:
        nonlocal i
        if i < n and tokens[i].kind == kind:
            t = tokens[i]
            i += 1
            return t
        return None

    while i < n:
        t = take("DATE_PAIR")
        if not t:
            # Skip non-transactional text
            i += 1
            continue

        # We don't actually need POST_DATE value; consume if present
        _ = take("POST_DATE")

        # Description is required for a transaction
        desc_tok = take("DESC")
        if not desc_tok:
            # Malformed; skip
            continue
        desc = clean_spaces(desc_tok.value)

        # Optional ID
        tx_id = "0"
        if peek({"ID"}):
            tx_id = take("ID").value  # type: ignore

        # Amount may be on the same line (AMOUNT_INLINE) or a separate AMOUNT line.
        amount: Optional[float] = None
        if peek({"AMOUNT_INLINE"}):
            amount = float(take("AMOUNT_INLINE").value)  # type: ignore
        else:
            # gobble any TEXT until we see AMOUNT or next DATE_PAIR
            j = i
            while j < n and tokens[j].kind not in {"DATE_PAIR", "AMOUNT"}:
                j += 1
            # If next token is AMOUNT, consume it
            if j < n and tokens[j].kind == "AMOUNT":
                i = j + 1
                amount = float(tokens[j].value)
            else:
                i = j

        # If amount still missing, try extracting from the description as a last resort
        if amount is None:
            amount = parse_amount(desc)

        # If still missing, skip this record
        if amount is None:
            log_change(f"Warning: no amount found near line {desc_tok.line_no}: '{desc}'")
            continue

        # Infer date from DATE_PAIR token
        m1, d1 = t.value.split(",")
        tx_date = normalize_date(m1.upper(), d1, start_mon, start_year, end_year)

        # Build transaction record
        tx = {
            "Date": tx_date,
            "ID": tx_id,
            "Tag": desc,
            "Name": "N/A",
            "Amount": amount,
            "Type": classify_type(desc, amount),
            "Category": "N/A",
            "Source": source.upper(),
        }

        out.append(tx)

    return out


def scan_summary_row(U: str, phrase: str, label: str, is_income: bool,
                     start_mon: int, start_year: int, end_year: int) -> List[Dict[str, Any]]:
    """
    Find a summary line (no ID) by phrase, grab amount and month/day tokens near it,
    and build a synthetic row (ID='0'). Works on squashed PDFs.
    """
    out: List[Dict[str, Any]] = []
    UU = U.upper()
    # Search in a no-space copy to survive tight PDFs
    NOS = UU.replace(" ", "")
    m_phrase = re.search(re.sub(r'\s+', '', phrase), NOS)
    if not m_phrase:
        return out

    # Search around phrase in original U for $amount and month/day tokens
    a, b = max(0, m_phrase.start()-240), min(len(U), m_phrase.end()+360)
    window = U[a:b]

    m_amt = re.search(r'[-–−U]?\s*\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2}))', window)
    m_mds = list(re.finditer(r'(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\d{2}', window, flags=re.I))
    if not m_amt or not m_mds:
        return out

    # Use the first month/day token after the amount (fallback: first token)
    amt_pos = m_amt.start()
    md_after = [md for md in m_mds if md.start() >= amt_pos]
    pick = md_after[0] if md_after else m_mds[0]
    mon1 = pick.group(1).upper()
    d1   = re.search(r'\d{2}', pick.group(0)).group(0)
    tx_date = normalize_date(mon1, d1, start_mon, start_year, end_year)

    num   = float(m_amt.group(1).replace(',', ''))
    value = num if is_income else num  # income/expense handled in Type
    typ   = "Income" if is_income else "Expense"

    out.append({
        "Date": tx_date,
        "ID": "0",
        "Tag": label,
        "Name": "N/A",
        "Amount": value,
        "Type": typ,
        "Category": "N/A",
        "Source": "CREDIT",
    })
    return out



def stream_scan_transactions(text: str, source: str) -> Tuple[List[Dict[str, Any]], Tuple[int,int,int]]:
    """
    ID-anchored parser robust to squashed PDFs.

    For each long ID:
      • Search BOTH forward and backward (bounded by prev/next ID) for the nearest $amount.
      • Around that amount, choose the two nearest month-day tokens (JAN..DEC + 2 digits),
        preferring forward, then nearest consecutive pair.
      • Build Tag from the span between the previous txn end and the current ID (cleaned).

    Also scans for summary rows with no IDs (AUTOMATIC PAYMENT / CASH ADVANCE INTEREST).
    """

    U = text
    UU = U.upper()

    # --- Statement period (year disambiguation) ---
    start_mon = start_year = end_year = None
    mm = HEADER_PERIOD_NOSP_RE.search(UU)
    if mm:
        sm = mm.group("sm").upper()
        start_mon = MONTHS.get(sm, 1)
        start_year = int(mm.group("sy"))
        end_year = int(mm.group("ey"))
    else:
        today = date.today()
        if "DEC" in UU and "JAN" in UU:
            start_mon, start_year, end_year = 12, today.year - 1, today.year
        else:
            start_mon = today.month
            start_year = today.year
            end_year = today.year

    id_re  = re.compile(r'\d{14,}')
    amt_re = re.compile(r'(?P<sign>[-–−U]?)\s*\$\s*(?P<num>\d{1,3}(?:,\d{3})*(?:\.\d{1,2}))')
    md_re  = re.compile(r'(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\d{2}', re.I)

    ids = list(id_re.finditer(U))
    rows: List[Dict[str, Any]] = []
    prev_tx_end = 0

    def find_amount_around(pos: int, left: int, right: int) -> Optional[re.Match]:
        """
        Find the nearest $amount to 'pos', searching both directions within [left, right].
        Preference: first forward hit, else the closest by absolute distance.
        """
        window_left  = max(left,  pos - 240)
        window_right = min(right, pos + 320)

        forward = amt_re.search(U, pos, window_right)
        if forward:
            return forward

        # Collect all amounts in window, pick the one with smallest |start - pos|
        hits = list(amt_re.finditer(U, window_left, window_right))
        if not hits:
            return None
        return min(hits, key=lambda m: abs(m.start() - pos))

    def choose_two_mday_tokens(amt_pos: int, left: int, right: int) -> Optional[Tuple[re.Match, re.Match]]:
        """
        Choose two month-day tokens near amt_pos, bounded to [left, right].
        Preference: first two forward tokens; else nearest consecutive pair.
        """
        hits = list(md_re.finditer(U, max(left, amt_pos), min(right, amt_pos + 240)))
        if len(hits) >= 2:
            return hits[0], hits[1]

        # widen both sides a bit, still within [left, right]
        hits = list(md_re.finditer(U, max(left, amt_pos - 200), min(right, amt_pos + 320)))
        if len(hits) < 2:
            return None

        # pick consecutive pair with minimum distance to amt_pos
        best, best_dist = None, 10**9
        for i in range(len(hits) - 1):
            a, b = hits[i], hits[i+1]
            dist = min(abs(a.start() - amt_pos), abs(b.start() - amt_pos))
            if dist < best_dist:
                best, best_dist = (a, b), dist
        return best

    for idx, m_id in enumerate(ids):
        i0, i1 = m_id.span()
        prev_bound = ids[idx-1].end() if idx > 0 else 0
        next_bound = ids[idx+1].start() if idx+1 < len(ids) else len(U)

        # 1) Find amount nearest to ID (both directions, bounded)
        m_amt = find_amount_around(i0, prev_bound, next_bound)
        if not m_amt:
            continue
        amt_pos = m_amt.start()

        # 2) Find two month/day tokens around that amount (bounded)
        pair = choose_two_mday_tokens(amt_pos, prev_bound, next_bound)
        if not pair:
            continue
        sel0, sel1 = pair

        # 3) Extract date from the FIRST token
        m1txt = sel0.group(0)
        mon1  = sel0.group(1).upper()
        d1    = re.search(r'\d{2}', m1txt).group(0)
        tx_date = normalize_date(mon1, d1, start_mon, start_year, end_year)

        # 4) Build Tag from stream slice between previous txn end and current ID
        raw_tag = clean_spaces(U[prev_tx_end:i0])
        # Trim leading month/day noise and long IDs leftover
        md_hits = list(md_re.finditer(raw_tag))
        if md_hits:
            raw_tag = raw_tag[md_hits[-1].end():]
        raw_tag = re.sub(r'\d{14,}.*$', '', raw_tag)

        tag = prettify_tag_basic(raw_tag)
        tag = prettify_tag_with_fixes(tag, load_merchant_fixes())
        tag = prettify_tag_basic(tag)

        # 5) Amount & Type
        num  = m_amt.group('num').replace(',', '')
        sign = -1.0 if (m_amt.group('sign') or '').strip() in ('-', '–', '−', 'U') else 1.0
        amount = float(num) * sign

        rows.append({
            "Date": tx_date,
            "ID": m_id.group(0),
            "Tag": tag,
            "Name": "N/A",
            "Amount": amount,
            "Type": classify_type(tag, amount),
            "Category": "N/A",
            "Source": source.upper(),
        })

        # move end marker safely past the second token we used
        prev_tx_end = max(prev_tx_end, sel1.end())

    # --- Summary rows with no ID (code-only; no config needed) ---
    # Automatic Payment
    rows.extend(scan_summary_row(
        U, phrase=r'AUTOMATIC\s*PAYMENT', label='AUTOMATIC PAYMENT - THANK YOU',
        is_income=True,  # positive income
        start_mon=start_mon, start_year=start_year, end_year=end_year
    ))
    # Cash Advance Interest
    rows.extend(scan_summary_row(
        U, phrase=r'CASH\s*ADVANCE\s*INTEREST', label='CASH ADVANCE INTEREST',
        is_income=False,
        start_mon=start_mon, start_year=start_year, end_year=end_year
    ))

    # Deduplicate by (Date, ID, Amount); keep first
    seen, out = set(), []
    for r in rows:
        key = (r["Date"], r["ID"], round(float(r["Amount"]), 2))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)

    out.sort(key=lambda r: (r["Date"], r["ID"]))
    return out, (start_mon, start_year, end_year)

# ---------------------------- Public API ---------------------------------

def extract_transactions(
    pdf_path: str | Path,
    source: str = "DEBIT",
    include_header: bool = True,
    apply_ignores: bool = True,
) -> List[Dict[str, Any]]:
    """
    Extract transactions from an RBC Mastercard PDF into the canonical schema.
    """
    pdf_path = Path(pdf_path)
    text = extract_pdf_text(pdf_path)

    tokens, period = tokenize(text)
    rows = parse_transactions(tokens, period, source)
    if not rows:
        # Fall back to stream scanning for compact PDFs with no line breaks
        rows, period = stream_scan_transactions(text, source)

    # Apply ignores
    if apply_ignores:
        patterns = load_ignore_patterns()
        rows = [r for r in rows if not should_ignore_tx(r, patterns)]

    # Optionally coerce Amount to standard 2-decimal string (commented out by default)
    # for r in rows:
    #     r["Amount"] = f'{float(r["Amount"]):.2f}'

    # Sort by Date then ID for stable output
    rows.sort(key=lambda r: (r["Date"], r["ID"]))

    if include_header:
        return [{"Date":"Date","ID":"ID","Tag":"Tag","Name":"Name","Amount":"Amount","Type":"Type","Category":"Category","Source":"Source"}] + rows
    return rows




def rows_to_csv(rows: List[Dict[str, Any]]) -> str:
    """
    Convert rows to CSV (UTF-8, no BOM). Assumes all rows share the same keys.
    If the first row appears to be a header row (keys equal values), we skip writing it as data.
    """
    if not rows:
        # Always return a header-only CSV
        import io
        headers = ["Date","ID","Tag","Name","Amount","Type","Category","Source"]
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=headers)
        writer.writeheader()
        return buf.getvalue()

    import io
    headers = ["Date","ID","Tag","Name","Amount","Type","Category","Source"]
    # Detect header-like first row
    first = rows[0]
    header_like = all(k in first and str(first[k]).lower() == k.lower() for k in headers)

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=headers)
    writer.writeheader()
    for idx, r in enumerate(rows):
        if idx == 0 and header_like:
            continue  # skip header-like data row
        rr = {k: r.get(k, "") for k in headers}
        if isinstance(rr["Amount"], float):
            s = f"{rr['Amount']:.2f}"
            s = s.rstrip("0").rstrip(".") if "." in s else s
            rr["Amount"] = s
        writer.writerow(rr)
    return buf.getvalue()
def save_rows_to_csv(
    rows: List[Dict[str, Any]],
    out_root: Path,
    source: str,
    statement_period_hint: Optional[str] = None
) -> Path:
    """
    Save rows into ./Credit or ./Debit under 'out_root' based on 'source'.
    Filenames include an optional 'statement_period_hint' (e.g., '2024-12_to_2025-01').
    """
    headers = ["Date","ID","Tag","Name","Amount","Type","Category","Source"]
    # deriver period hint from first/last date if not provided
    dates = [r["Date"] for r in rows if r.get("Date") and r["Date"] != "Date"]
    if not statement_period_hint and dates:
        statement_period_hint = f"{dates[0]}_to_{dates[-1]}"
    folder = out_root / (source.upper())
    folder.mkdir(parents=True, exist_ok=True)
    fname = f"statement_{statement_period_hint or 'output'}.csv"
    path = folder / fname
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for r in rows:
            rr = {k: r.get(k, "") for k in headers}
            if isinstance(rr["Amount"], float):
                s = f"{rr['Amount']:.2f}"
                s = s.rstrip("0").rstrip(".") if "." in s else s
                rr["Amount"] = s
            writer.writerow(rr)
    return path



# ------------------------------ Tag Refiners ------------------------------

PROV_RE = re.compile(r'(ON|QC|AB|BC|MB|NS|NB|NL|PE|SK|YT|NT|NU)$', re.IGNORECASE)


DEFAULT_MERCHANT_FIXES = [
    (re.compile(r'TIMHORTONS', re.I), 'TIM HORTONS'),
    (re.compile(r'T&TSUPERMARKET', re.I), 'T&T SUPERMARKET'),
    (re.compile(r'REDSWANPIZZA', re.I), 'RED SWAN PIZZA'),
    (re.compile(r'SHOPPERSDRUGMART', re.I), 'SHOPPERS DRUG MART'),
    (re.compile(r'MARYBROWNSCHICKEN', re.I), 'MARY BROWNS CHICKEN'),
    (re.compile(r'CANADACOMPUTERS', re.I), 'CANADA COMPUTERS'),
    (re.compile(r'THEHOMEDEPOT', re.I), 'THE HOME DEPOT'),
    (re.compile(r'STEAMPURCHASE', re.I), 'STEAM PURCHASE'),
    (re.compile(r'UBERCANADA/UBEREATS', re.I), 'UBER CANADA/UBER EATS'),
    (re.compile(r'SHAWARMAPRINCE', re.I), 'SHAWARMA PRINCE'),
    (re.compile(r'SHAWARMAPALACE', re.I), 'SHAWARMA PALACE'),
    (re.compile(r'RIDEAUBOURBONST\.?GRI', re.I), 'RIDEAU BOURBON ST. GRI'),
    (re.compile(r'RANGDEINDIANCUISINE', re.I), 'RANG DE INDIAN CUISINE'),
    (re.compile(r'SUSHIEKI', re.I), 'SUSHI EKI'),
    (re.compile(r'RCSSSOUTH', re.I), 'RCSS SOUTH'),

    (re.compile(r'RBCROYALBANK', re.I), 'RBC ROYAL BANK'),
    (re.compile(r'RIDEAUCENTRE', re.I), 'RIDEAU CENTRE'),
    (re.compile(r'CASH-SERVICECHARGE', re.I), 'CASH - SERVICE CHARGE'),
]


def load_merchant_fixes() -> List[Tuple[re.Pattern, str]]:
    """
    Optional user overrides in config/merchant_fixes.txt with lines like:
      TIMHORTONS => TIM HORTONS
    Case-insensitive. Lines starting with # ignored.
    """
    path = CONFIG_FOLDER / "merchant_fixes.txt"
    fixes = list(DEFAULT_MERCHANT_FIXES)
    try:
        if path.exists():
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=>' not in line:
                        continue
                    src, dst = [s.strip() for s in line.split('=>', 1)]
                    if src and dst:
                        fixes.append((re.compile(re.escape(src), re.I), dst))
    except Exception as e:
        log_change(f"Failed reading merchant_fixes.txt: {e}")
    return fixes

def prettify_tag_basic(tag: str) -> str:
    """Generic spacing rules to de-squish a tag."""
    if not tag:
        return tag
    t = tag
    # Ensure separator spacing
    t = re.sub(r'([*/#])', r' \1 ', t)
    # Space between letters and digits
    t = re.sub(r'(?<=[A-Za-z])(?=\d)', ' ', t)
    t = re.sub(r'(?<=\d)(?=[A-Za-z])', ' ', t)
    # Collapse runs of spaces
    t = clean_spaces(t)
    # Add space before common city names
    cities = r'(KANATA|OTTAWA|NEPEAN|STITTSVILLE|TORONTO|WILMINGTON|SEATTLE|BAYSHORE)'
    t = re.sub(r'(?i)(?P<pre>[A-Za-z.])(?=(?:' + cities + r')\b)', lambda m: m.group('pre') + ' ', t)
    # Province at end
    t = re.sub(PROV_RE, lambda m: f" {m.group(1).upper()}", t)
    t = clean_spaces(t)
    return t

def prettify_tag_with_fixes(tag: str, fixes: List[Tuple[re.Pattern, str]]) -> str:
    t = tag
    for pat, repl in fixes:
        t = pat.sub(repl, t)
    # Normalize multiple spaces
    t = clean_spaces(t)
    return t

def month_abbr_from_date(yyyy_mm_dd: str) -> str:
    mm = int(yyyy_mm_dd[5:7])
    for k, v in MONTHS.items():
        if v == mm:
            return k
    return 'JAN'

def refine_tags_with_pdf(pdf_path: Path, rows: List[Dict[str, Any]], window: int = 180) -> List[Dict[str, Any]]:
    """
    Re-read PDF text and re-derive a 'better' Tag for each row by grabbing the
    text span immediately before the row's ID and up to the posting date token.
    Then apply spacing heuristics and a merchant-fixes dictionary.
    """
    raw = extract_pdf_text(pdf_path)
    fixes = load_merchant_fixes()
    T = raw  # already normalized by extract_pdf_text

    out: List[Dict[str, Any]] = []
    for r in rows:
        tag0 = r.get("Tag", "")
        tx_id = str(r.get("ID", ""))
        if not tx_id or tx_id == "0":
            # For no-ID transactions, just prettify the existing tag
            pretty = prettify_tag_basic(tag0)
            pretty = prettify_tag_with_fixes(pretty, fixes)
            rr = dict(r)
            rr["Tag"] = pretty
            out.append(rr)
            continue

        # Build a regex: capture up to `window` chars before ID until the known transaction date token
        try:
            mon = month_abbr_from_date(r["Date"])
            dd = int(r["Date"][8:10])
            patt = re.compile(rf'(.{{0,{window}}}){re.escape(tx_id)}.*?{mon}{dd:02d}', re.I)
            m = patt.search(T)
            if not m:
                # fallback: capture preceding slice only
                idx = T.find(tx_id)
                seg = T[max(0, idx-window):idx] if idx != -1 else tag0
            else:
                seg = m.group(1)
        except Exception:
            seg = tag0

        
        # Cleanup the captured segment
        seg = clean_spaces(seg)

        # Strip everything up to the LAST month+day token within the segment (if any)
        md_pat = re.compile(r'(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\d{2}', re.I)
        last_md = None
        for mmd in md_pat.finditer(seg):
            last_md = mmd
        if last_md:
            seg = seg[last_md.end():]

        # Also strip any leading month+day if still present (safety)
        seg = re.sub(r'^(?:\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\d{2}\s*)+', '', seg, flags=re.IGNORECASE)

        # Trim any stray long IDs (safety)
        seg = re.sub(r'\d{14,}.*$', '', seg)

        # Prettify
        pretty = prettify_tag_basic(seg if seg else tag0)
        pretty = prettify_tag_with_fixes(pretty, fixes)
        pretty = prettify_tag_basic(pretty)

        rr = dict(r)
        rr["Tag"] = pretty
        out.append(rr)

    return out

def realign_dates_with_pdf(pdf_path: Path, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    For each ID-backed row, re-open the PDF text and pick the closest month-day pair
    around the ($amount, ID) anchor. Adjust Date accordingly (keeps year logic).
    """
    raw = extract_pdf_text(pdf_path)
    U = raw
    UU = U.upper()
    id_re = re.compile(r'\d{14,}')
    amt_num = re.compile(r'\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2}))')
    md_re  = re.compile(r'(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\d{2}', re.I)

    # Period (year resolution)
    mm = HEADER_PERIOD_NOSP_RE.search(UU)
    if mm:
        sm = mm.group("sm").upper()
        start_mon = MONTHS.get(sm, 1)
        start_year = int(mm.group("sy"))
        end_year = int(mm.group("ey"))
    else:
        today = date.today()
        if "DEC" in UU and "JAN" in UU:
            start_mon = 12; start_year = today.year - 1; end_year = today.year
        else:
            start_mon = today.month; start_year = today.year; end_year = today.year

    out = []
    for r in rows:
        if not r.get("ID") or r["ID"] == "0":
            out.append(r); continue
        txid = str(r["ID"])

        pos = U.find(txid)
        if pos == -1:
            out.append(r); continue

        # Find a nearby amount occurrence matching our amount
        amt_pat = re.compile(r'[\-–−U]?\s*\$\s*' + re.escape(f"{abs(float(r['Amount'])):,.2f}"))
        m_amt = amt_pat.search(U, max(0, pos-80), min(len(U), pos+320))
        if not m_amt:
            out.append(r); continue
        amt_pos = m_amt.start()

        # Collect month-day tokens in a generous window
        win_a = max(0, amt_pos - 260)
        win_b = min(len(U), amt_pos + 360)
        tokens = list(md_re.finditer(U, win_a, win_b))
        if len(tokens) < 2:
            out.append(r); continue

        # Prefer the first forward pair after amount; else choose the nearest pair (either side)
        forward = [t for t in tokens if t.start() >= amt_pos]
        if len(forward) >= 2:
            sel0, sel1 = forward[0], forward[1]
        else:
            # choose consecutive pair minimizing distance to amt_pos
            best_pair, best_dist = None, 10**9
            for i in range(len(tokens)-1):
                a, b = tokens[i], tokens[i+1]
                dist = min(abs(a.start()-amt_pos), abs(b.start()-amt_pos))
                if dist < best_dist:
                    best_dist, best_pair = dist, (a, b)
            sel0, sel1 = best_pair

        m1txt = sel0.group(0)
        mon1 = sel0.group(1).upper()
        d1 = re.search(r'\d{2}', m1txt).group(0)
        new_date = normalize_date(mon1, d1, start_mon, start_year, end_year)

        rr = dict(r)
        rr["Date"] = new_date
        out.append(rr)

    return out

# ------------------------------ ID Overrides ------------------------------
def load_id_overrides() -> Dict[str, Dict[str, str]]:
    """
    Optional CSV file config/id_overrides.csv with headers:
      ID,Date,Tag
    Date should be YYYY-MM-DD (we do basic validation). Tag is optional.
    """
    import csv
    path = CONFIG_FOLDER / "id_overrides.csv"
    out: Dict[str, Dict[str, str]] = {}
    try:
        if path.exists():
            with open(path, 'r', encoding='utf-8') as f:
                rdr = csv.DictReader(f)
                for row in rdr:
                    idv = (row.get('ID') or '').strip()
                    if not idv:
                        continue
                    item: Dict[str, str] = {}
                    d = (row.get('Date') or '').strip()
                    if d and re.match(r'^\d{4}-\d{2}-\d{2}$', d):
                        item['Date'] = d
                    t = (row.get('Tag') or '').strip()
                    if t:
                        item['Tag'] = t
                    if item:
                        out[idv] = item
    except Exception as e:
        log_change(f"Failed reading id_overrides.csv: {e}")
    return out

def apply_id_overrides(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    overrides = load_id_overrides()
    if not overrides:
        return rows
    out = []
    for r in rows:
        rr = dict(r)
        ov = overrides.get(str(r.get('ID','')))
        if ov:
            if 'Date' in ov and ov['Date']:
                rr['Date'] = ov['Date']
            if 'Tag' in ov and ov['Tag']:
                rr['Tag'] = ov['Tag']
        out.append(rr)
    return out

def load_injected_rows(default_source: str) -> List[Dict[str, Any]]:
    """
    Optional CSV file config/inject_rows.csv with headers exactly:
      Date,ID,Tag,Name,Amount,Type,Category,Source
    Rows will be appended; use this for summary items not tokenized from the stream.
    If Source is empty, default to default_source.
    """
    import csv
    path = CONFIG_FOLDER / "inject_rows.csv"
    out: List[Dict[str, Any]] = []
    try:
        if path.exists():
            with open(path, 'r', encoding='utf-8') as f:
                rdr = csv.DictReader(f)
                for r in rdr:
                    rr = {k: (r.get(k, '') or '').strip() for k in ["Date","ID","Tag","Name","Amount","Type","Category","Source"]}
                    if not rr["Date"] or not rr["Tag"] or not rr["Amount"]:
                        continue
                    if not rr["ID"]:
                        rr["ID"] = "0"
                    if not rr["Name"]:
                        rr["Name"] = "N/A"
                    if not rr["Category"]:
                        rr["Category"] = "N/A"
                    if not rr["Source"]:
                        rr["Source"] = default_source
                    # coerce amount
                    try:
                        rr["Amount"] = float(rr["Amount"])
                    except Exception:
                        continue
                    # normalize Type
                    rr["Type"] = "Income" if str(rr["Type"]).strip().lower().startswith("in") or float(rr["Amount"]) < 0 else "Expense"
                    out.append(rr)
    except Exception as e:
        log_change(f"Failed reading inject_rows.csv: {e}")
    return out
# ------------------------------- CLI -------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Extract RBC Mastercard PDF statement into CSV rows.")
    p.add_argument("pdf", help="Path to the statement PDF")
    p.add_argument("--source", choices=["DEBIT","CREDIT"], default="DEBIT", help="Populate the 'Source' column (default: DEBIT)")
    p.add_argument("--save", action="store_true", help="If set, save CSV into ./Credit or ./Debit (based on --source)")
    p.add_argument("--outdir", default=".", help="Root output directory for --save (default: current directory)")
    p.add_argument("--read", action="store_true", help="If set, print parsed data to STDOUT (CSV by default)")
    p.add_argument("--refine-tags", action="store_true", help="Re-read the PDF to improve Tag spacing using heuristics/dictionary")
    p.add_argument("--realign-dates", action="store_true", help="Re-open the PDF text and realign dates by choosing nearest month/day pair around each amount-ID anchor")
    p.add_argument("--no-overrides", action="store_true", help="Do not apply ID/date overrides from config/id_overrides.csv")
    p.add_argument("--inject", action="store_true", help="Append rows from config/inject_rows.csv after parsing/refinement")
    p.add_argument("--format", choices=["csv","json"], default="csv", help="When using --read, choose output format (default: csv)")
    p.add_argument("--no-header", action="store_true", help="Omit the header row in outputs (programmatic use)")
    p.add_argument("--no-ignores", action="store_true", help="Do not apply ignore patterns")
    return p


def main(argv: Optional[List[str]] = None) -> None:
    args = build_arg_parser().parse_args(argv)
    pdf_path = Path(args.pdf)
    rows = extract_transactions(
        pdf_path,
        source=args.source,
        include_header=(not args.no_header),
        apply_ignores=(not args.no_ignores),
    )
    # Optional refinement pass on Tags
    if args.refine_tags:
        core = rows[1:] if rows and rows[0].get("Date") == "Date" else rows
        refined = refine_tags_with_pdf(pdf_path, core)
        rows = ([rows[0]] + refined) if (rows and rows[0].get("Date") == "Date") else refined
    if args.realign_dates:
        core = rows[1:] if rows and rows[0].get("Date") == "Date" else rows
        aligned = realign_dates_with_pdf(pdf_path, core)
        rows = ([rows[0]] + aligned) if (rows and rows[0].get("Date") == "Date") else aligned
    # Finally, apply overrides unless disabled
    if not args.no_overrides:
        core = rows[1:] if rows and rows[0].get("Date") == "Date" else rows
        core = apply_id_overrides(core)
        rows = ([rows[0]] + core) if (rows and rows[0].get("Date") == "Date") else core
    if args.inject:
        header = rows[0] if rows and rows[0].get("Date") == "Date" else None
        body = rows[1:] if header else rows
        injected = load_injected_rows(args.source.upper())
        body = body + injected
        rows = [header] + body if header else body

    # --read => print to STDOUT
    if args.read:
        if args.format == "json":
            # Convert floats to trimmed string for JSON consistency
            def _fmt_amount(a):
                if isinstance(a, float):
                    s = f"{a:.2f}"
                    return s.rstrip("0").rstrip(".") if "." in s else s
                return a
            out = [
                {k: (_fmt_amount(v) if k == "Amount" else v) for k, v in r.items()}
                for r in rows
            ]
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            print(rows_to_csv(rows), end="")
        return

    # --save => write CSV file
    if args.save:
        out_root = Path(args.outdir)
        saved = save_rows_to_csv(rows, out_root=out_root, source=args.source)
        print(f"Saved: {saved}")
        return

    # Default: just show a short summary
    print(f"Parsed {max(0, len(rows)-1)} transactions from '{pdf_path.name}'.")
    print("Tip: use --read to print them, or --save to write a CSV.")

if __name__ == "__main__":
    main()
