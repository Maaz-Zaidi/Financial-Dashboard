#!/usr/bin/env python3

import os
import sys
import csv
import shutil
import re
from datetime import datetime
from decimal import Decimal
import matplotlib.pyplot as plt
from collections import defaultdict

DEBIT_FOLDER = "Debit"
CREDIT_FOLDER = "Credit"
RESULT_FOLDER = "Result"
ARCHIVE_FOLDER = "Archive"
OUTPUT_FILENAME = "combined_transactions.csv"
SUMMARY_OUTPUT_FILENAME = "combined_transactions_with_summary.csv"
CSV_HEADER = ["Date", "ID", "Tag", "Name", "Amount", "Type", "Category", "Source"]
LOG_FILE = "log.txt"
STARTING_BALANCE = Decimal("0.00")

CONFIG_FOLDER = "Config"
IGNORE_FILE = os.path.join(CONFIG_FOLDER, "ignores.txt")

def load_ignore_patterns():
  patterns = []
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

def should_ignore_tx(tx, patterns):
  tag  = (tx.get("Tag")  or "").lower()
  name = (tx.get("Name") or "").lower()
  for p in patterns:
      if p in tag or p in name:
          return True
  return False


def read_and_print_csv():
    base = os.path.dirname(__file__)
    csv_path = os.path.join(base, 'Result', 'combined_transactions.csv')
    with open(csv_path, 'r', encoding='utf-8') as f:
        sys.stdout.write(f.read())
    sys.exit(0)

if '--read' in sys.argv:
    read_and_print_csv()

def log_change(message):
    timestamp = datetime.now().isoformat()
    full_msg = f"{timestamp} - {message}"
    print(full_msg)
    with open(LOG_FILE, 'a', encoding='utf-8') as log_file:
        log_file.write(full_msg + "\n")


def get_csv_files(folder_path):
    """
    list of paths to all .csv files in the given folder.
    """
    if not os.path.isdir(folder_path):
        return []
    return [
        os.path.join(folder_path, f)
        for f in os.listdir(folder_path)
        if f.lower().endswith('.csv')
    ]


def read_transactions_from_folder(folder_path, source_label):
    """
    Reads the transactions
    """
    transactions = []
    for file_path in get_csv_files(folder_path):
        with open(file_path, newline='', encoding='utf-8') as csvfile:
            reader = csv.reader(csvfile)
            for row in reader:
                if row == CSV_HEADER or len(row) != len(CSV_HEADER):
                    continue
                date, id_, tag, name, amount, type_, category, source = [col.strip() for col in row]
                clean_amount = amount.lstrip('-')
                transactions.append({
                    "Date": date,
                    "ID": id_,
                    "Tag": tag,
                    "Name": name,
                    "Amount": clean_amount,
                    "Type": type_,
                    "Category": category,
                    "Source": source_label
                })
    return transactions


def clean_transactions(transactions):
    """
    data cleaning
    """
    cleaned = []
    sci_pattern = re.compile(r'^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$')
    for tx in transactions:
        date = tx["Date"]; id_ = tx["ID"]; tag = tx["Tag"]
        name = tx["Name"]; amount = tx["Amount"]; type_ = tx["Type"]
        category = tx["Category"]; source = tx["Source"]

        if tag.upper().startswith("AUTOMATIC PAYMENT"):
            log_change(f"Skipped AUTOMATIC PAYMENT entry: {{'Date': date, 'ID': id_, 'Tag': tag}}")
            continue

        if sci_pattern.match(id_):
            original = id_
            try:
                expanded = str(Decimal(id_).to_integral_value())
            except Exception as e:
                log_change(f"Error expanding scientific ID '{id_}': {e}")
                expanded = id_
            id_ = expanded
            log_change(f"Expanded scientific ID '{original}' to '{id_}' for Date {date}")

        if any(c.isalpha() for c in id_):
            original = id_
            id_ = '0'
            parts = tag.split()
            if original not in parts:
                tag = f"{tag} {original}".strip()
            log_change(f"Replaced alphabetic ID '{original}' with '0' and updated Tag to '{tag}' for Date {date}")

        cleaned.append({
            "Date": date,
            "ID": id_,
            "Tag": tag,
            "Name": name,
            "Amount": amount,
            "Type": type_,
            "Category": category,
            "Source": source
        })
    return cleaned


def deduplicate_transactions(transactions):
    """
    Duplicate removal
    """
    seen = set()
    unique = []
    for tx in transactions:
        key = (tx["Date"], tx["ID"], tx["Tag"], tx["Type"], tx["Amount"])
        if key not in seen:
            seen.add(key)
            unique.append(tx)
        else:
            log_change(f"Duplicate removed: {{'Date': tx['Date'], 'ID': tx['ID'], 'Tag': tx['Tag'], 'Amount': tx['Amount']}}")
    return unique


def archive_existing_results():
    """
    Folder organization (archiving of past results)
    """
    if not os.path.isdir(RESULT_FOLDER):
        return
    os.makedirs(ARCHIVE_FOLDER, exist_ok=True)
    for fname in os.listdir(RESULT_FOLDER):
        src = os.path.join(RESULT_FOLDER, fname)
        if os.path.isfile(src):
            ts = datetime.now().strftime("%Y%m%d%H%M%S")
            dst = os.path.join(ARCHIVE_FOLDER, f"{ts}_{fname}")
            shutil.move(src, dst)
            log_change(f"Archived old result file: {fname} -> {dst}")


def generate(transactions):
    """
    Generate result.csv file
    """
    os.makedirs(RESULT_FOLDER, exist_ok=True)
    archive_existing_results()
    out = os.path.join(RESULT_FOLDER, OUTPUT_FILENAME)
    with open(out, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(CSV_HEADER)
        for tx in sorted(transactions, key=lambda x: x["Date"]):
            writer.writerow([tx[col] for col in CSV_HEADER])
    log_change(f"Generated combined CSV: {out}")


def summarize_transactions(transactions):
    """
    Summarize expenses and incomes per category and overall
    """
    cat_sum = defaultdict(lambda: {"expense": Decimal("0"), "income": Decimal("0")})
    total = {"expense": Decimal("0"), "income": Decimal("0")}
    for tx in transactions:
        # Safely parse Amount, skip invalid entries
        try:
            amt = Decimal(tx["Amount"])
        except Exception as e:
            log_change(f"Skipped transaction with invalid Amount '{tx['Amount']}' on {tx['Date']}: {e}")
            continue
        if tx["Type"].lower() == "expense":
            cat_sum[tx["Category"]]["expense"] += amt
            total["expense"] += amt
        else:
            cat_sum[tx["Category"]]["income"] += amt
            total["income"] += amt
    return cat_sum, total


def write_summary_csv(transactions, starting_balance):
    """
    Write a CSV including overall and per-year-month summaries.
    """
    summary, total = summarize_transactions(transactions)
    # group by year-month
    ym_groups = defaultdict(list)
    for tx in transactions:
        try:
            dt = datetime.fromisoformat(tx["Date"])
        except Exception:
            log_change(f"Invalid Date format '{tx['Date']}', skipping for summary")
            continue
        key = f"{dt.year}-{dt.month:02d}"
        ym_groups[key].append(tx)

    out_path = os.path.join(RESULT_FOLDER, SUMMARY_OUTPUT_FILENAME)
    with open(out_path, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.writer(csvfile)
        hdr = ["Group", "Category", "Expense", "Income", "Net", "Net_With_Starting_Balance"]
        writer.writerow(hdr)
        for cat, vals in summary.items():
            exp = vals["expense"]; inc = vals["income"]
            net = inc - exp; net_ws = net + starting_balance
            writer.writerow(["ALL", cat, f"{exp:.2f}", f"{inc:.2f}", f"{net:.2f}", f"{net_ws:.2f}"])
        tot_net = total["income"] - total["expense"]
        tot_ws = tot_net + starting_balance
        writer.writerow(["ALL", "TOTAL", f"{total['expense']:.2f}", f"{total['income']:.2f}", f"{tot_net:.2f}", f"{tot_ws:.2f}"])
        for grp in sorted(ym_groups):
            cats_m, tot_m = summarize_transactions(ym_groups[grp])
            for cat, vals in cats_m.items():
                exp = vals["expense"]; inc = vals["income"]
                net = inc - exp; net_ws = net + starting_balance
                writer.writerow([grp, cat, f"{exp:.2f}", f"{inc:.2f}", f"{net:.2f}", f"{net_ws:.2f}"])
            net_m = tot_m["income"] - tot_m["expense"]
            net_ws_m = net_m + starting_balance
            writer.writerow([grp, "TOTAL", f"{tot_m['expense']:.2f}", f"{tot_m['income']:.2f}", f"{net_m:.2f}", f"{net_ws_m:.2f}"])
    log_change(f"Generated summary CSV: {out_path}")


def generate_plots(transactions, starting_balance):
    """
    Generate line plot of net totals per category over months.
    """
    # group by year-month
    ym_groups = defaultdict(list)
    for tx in transactions:
        try:
            dt = datetime.fromisoformat(tx["Date"])
        except Exception:
            continue
        key = f"{dt.year}-{dt.month:02d}"
        ym_groups[key].append(tx)
    months = sorted(ym_groups)
    categories = sorted({tx["Category"] for tx in transactions})
    data = {cat: [] for cat in categories}
    data["TOTAL"] = []
    for m in months:
        cats_m, tot_m = summarize_transactions(ym_groups[m])
        for cat in categories:
            vals = cats_m.get(cat, {"expense": Decimal("0"), "income": Decimal("0")})
            net = vals["income"] - vals["expense"]
            data[cat].append(float(net))
        total_net = tot_m["income"] - tot_m["expense"]
        data["TOTAL"].append(float(total_net))
    # plot
    for cat, vals in data.items():
        plt.plot(months, vals, label=cat)
    plt.xlabel("Month")
    plt.ylabel("Net Total")
    plt.title("Net Total by Category Over Time")
    plt.legend()
    os.makedirs(RESULT_FOLDER, exist_ok=True)
    plot_path = os.path.join(RESULT_FOLDER, "net_trends.png")
    plt.savefig(plot_path)
    plt.clf()
    log_change(f"Generated plot: {plot_path}")


def main():
    debit = read_transactions_from_folder(DEBIT_FOLDER, "DEBIT")
    credit = read_transactions_from_folder(CREDIT_FOLDER, "CREDIT")
    all_txs = debit + credit
    cleaned = clean_transactions(all_txs)
    unique = deduplicate_transactions(cleaned)

    ignore_patterns = load_ignore_patterns()
    if ignore_patterns:
        before = len(unique)
        unique = [tx for tx in unique if not should_ignore_tx(tx, ignore_patterns)]
        skipped = before - len(unique)
        if skipped:
            log_change(f"Ignored {skipped} transactions due to ignores.txt patterns")


    generate(unique)
    #write_summary_csv(unique, STARTING_BALANCE)
    #generate_plots(unique, STARTING_BALANCE)


if __name__ == "__main__":
    main()
