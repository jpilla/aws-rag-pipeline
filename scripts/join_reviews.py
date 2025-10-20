#!/usr/bin/env python3
import argparse, json, gzip, re, html
from datetime import datetime
from pathlib import Path

def open_maybe_gzip(path, mode="rt"):
    return gzip.open(path, mode) if str(path).endswith(".gz") else open(path, mode, encoding="utf-8")

def strip_html(s: str | None) -> str:
    if not s: return ""
    # unescape entities then drop tags
    s = html.unescape(s)
    return re.sub(r"<[^>]+>", " ", s).strip()

def parse_price(price_str):
    if not price_str:
        return None
    s = str(price_str).strip()

    # common garbage -> None
    if s in {".", "-", "N/A", "na", "NA", ""}:
        return None

    # normalize grouping and currency
    # keep only digits and dots for scanning
    s = s.replace(",", "")
    # find a number with at least one digit; allows "19", "19.99", ".99" (we'll normalize)
    m = re.search(r'(?<!\d)(\d+(?:\.\d+)?|\.\d+)(?!\d)', s)
    if not m:
        return None

    num = m.group(1)
    # normalize ".99" -> "0.99"
    if num.startswith("."):
        num = "0" + num
    try:
        return float(num)
    except ValueError:
        return None

def parse_date(review_time_str: str | None, unix_ts: int | None) -> str | None:
    if unix_ts:  # prefer unix if present
        return datetime.utcfromtimestamp(int(unix_ts)).strftime("%Y-%m-%d")
    if not review_time_str: return None
    # e.g. "05 26, 2009"
    try:
        return datetime.strptime(review_time_str, "%m %d, %Y").strftime("%Y-%m-%d")
    except Exception:
        return None

def load_asin_meta(meta_path: Path, keep_fields=None, max_rows=None):
    keep_fields = keep_fields or ["title","brand","main_cat","category","price","rank"]
    asin_map = {}
    with open_maybe_gzip(meta_path, "rt") as f:
        for i, line in enumerate(f, 1):
            if not line.strip():
                continue
            obj = json.loads(line)
            asin = obj.get("asin")
            if not asin:
                continue

            # keep only requested fields
            rec = {k: obj.get(k) for k in keep_fields if k in obj}

            # sanitize a few common ones
            if "price" in rec:
                rec["price"] = parse_price(rec.get("price"))
            if "category" in rec and isinstance(rec["category"], str):
                rec["category"] = [rec["category"]]

            asin_map[asin] = rec
            if max_rows and i >= max_rows:
                break
    return asin_map

def make_embed_text(prod, review):
    """
    Build the ONCE string you will send to the embedding model.
    Keep it short, clear, and self-contained.
    """
    title = prod.get("title") or f"ASIN {review.get('asin','')}"
    brand = prod.get("brand")
    cats = prod.get("category") or []
    main_cat = prod.get("main_cat") or ""
    cat_line = (cats[0] if cats else main_cat) or "Toys & Games"
    rating = review.get("overall")
    verified = review.get("verified")
    summary = (review.get("summary") or "").strip()
    body = (review.get("reviewText") or "").strip()
    # keep it compact; no HTML; no IDs
    parts = [
        f"Product: {title}" + (f" (Brand: {brand})" if brand else ""),
        f"Category: {cat_line}",
        f"Rating: {int(rating)} stars" + (" (Verified Purchase)" if verified else "") if rating is not None else "",
        f"Review Summary: {summary}" if summary else "",
        f"Full Review: {body}"
    ]
    text = "\n".join(p for p in parts if p).strip()
    return text

def process_reviews(reviews_path: Path, asin_map, out_path: Path, drop_if_missing_meta=True):
    bad_asin = 0
    n_in, n_out = 0, 0
    with open_maybe_gzip(reviews_path, "rt") as fin, open(out_path, "w", encoding="utf-8") as fout:
        for line in fin:
            if not line.strip(): continue
            n_in += 1
            r = json.loads(line)
            asin = r.get("asin")
            if not asin: 
                continue
            prod = asin_map.get(asin)
            if not prod and drop_if_missing_meta:
                bad_asin += 1
                continue
            prod = prod or {}
            text = make_embed_text(prod, r)
            rec = {
                "id": f"{asin}_{r.get('reviewerID','')}_{r.get('unixReviewTime','')}",
                "asin": asin,
                "embedding_text": text,     # <- send THIS to the embedding API
                "meta": {
                    "product_title": prod.get("title"),
                    "brand": prod.get("brand"),
                    "main_cat": prod.get("main_cat"),
                    "categories": prod.get("category"),
                    "price": prod.get("price"),
                    "also_buy": prod.get("also_buy"),
                    "also_view": prod.get("also_view"),
                    "review_time": parse_date(r.get("reviewTime"), r.get("unixReviewTime")),
                    "rating": r.get("overall"),
                    "verified": r.get("verified"),
                    "review_summary": r.get("summary"),
                    # keeping original review text separately is handy for UI
                    "review_text": r.get("reviewText"),
                }
            }
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n_out += 1
    return {"read": n_in, "written": n_out, "missing_meta": bad_asin}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True, help="products metadata .jsonl or .jsonl.gz")
    ap.add_argument("--reviews", required=True, help="reviews .jsonl or .jsonl.gz")
    ap.add_argument("--out", required=True, help="output cleaned JSONL for embedding")
    args = ap.parse_args()

    asin_map = load_asin_meta(Path(args.meta))
    stats = process_reviews(Path(args.reviews), asin_map, Path(args.out))
    print(json.dumps({"stats": stats, "unique_asins_meta": len(asin_map)}, indent=2))

if __name__ == "__main__":
    main()