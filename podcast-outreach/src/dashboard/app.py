import json
import os
import sys
from pathlib import Path

import pandas as pd
import streamlit as st
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent.parent.parent / "config" / ".env")
if not os.path.exists(Path(__file__).parent.parent.parent / "config" / ".env"):
    load_dotenv()

from src.db.connect import get_engine

st.set_page_config(page_title="Podcast Outreach Dashboard", layout="wide")


@st.cache_resource
def engine():
    return get_engine()


@st.cache_data(ttl=60)
def load_podcasts():
    with engine().connect() as conn:
        result = conn.execute(text("""
            SELECT id, title, host_name, category, total_episodes, last_episode_date,
                   contact_email, linkedin_url, instagram_url, website, enriched_at,
                   listen_score, country
            FROM podcasts
            ORDER BY listen_score DESC NULLS LAST
            LIMIT 2000
        """))
        return pd.DataFrame(result.mappings().all())


def load_enrichment_results() -> list[dict]:
    results_dir = Path(__file__).parent.parent.parent / "data" / "enrichment_results"
    all_results = []
    for f in sorted(results_dir.glob("batch_*.json"), reverse=True):
        with open(f) as fp:
            data = json.load(fp)
        all_results.extend(data)
    return all_results


def load_scored_leads() -> pd.DataFrame | None:
    exports_dir = Path(__file__).parent.parent.parent / "data" / "exports"
    files = sorted(exports_dir.glob("scored_leads_*.xlsx"), reverse=True)
    if files:
        return pd.read_excel(files[0])
    return None


page = st.sidebar.radio(
    "Navigation",
    ["Enrichment Review", "Data Completeness", "Outreach Queue"],
)

if page == "Enrichment Review":
    st.title("Enrichment Results Review")

    results = load_enrichment_results()
    if not results:
        st.info("No enrichment results found. Run `python scripts/03_run_enrichment.py` first.")
        st.stop()

    has_new_data = [r for r in results if r.get("enriched_fields")]
    st.metric("Podcasts enriched", len(results))
    st.metric("New data found", len(has_new_data))

    if not has_new_data:
        st.warning("No new contact information was found in the latest enrichment run.")
        st.stop()

    df_results = pd.DataFrame(has_new_data)

    for _, row in df_results.iterrows():
        with st.expander(f"{row.get('title', 'Unknown')} — new: {', '.join(row.get('enriched_fields', []))}"):
            col1, col2 = st.columns(2)
            with col1:
                st.markdown("**New data found**")
                for field in row.get("enriched_fields", []):
                    st.write(f"  {field}: `{row.get(field)}`")
            with col2:
                st.markdown("**Actions**")
                podcast_id = row.get("podcast_id")

                approve_key = f"approve_{podcast_id}"
                reject_key = f"reject_{podcast_id}"

                if st.button("Approve", key=approve_key):
                    update_parts = []
                    params = {"id": str(podcast_id)}
                    field_map = {
                        "email": "contact_email",
                        "twitter": "instagram_url",
                        "linkedin": "linkedin_url",
                        "website": "website",
                        "host_name": "host_name",
                    }
                    for src_field, db_field in field_map.items():
                        if src_field in row.get("enriched_fields", []) and row.get(src_field):
                            update_parts.append(f"{db_field} = :{src_field}")
                            params[src_field] = row[src_field]

                    if update_parts:
                        update_parts.append("enriched_at = now()")
                        sql = f"UPDATE podcasts SET {', '.join(update_parts)} WHERE id = :id"
                        with engine().connect() as conn:
                            conn.execute(text(sql), params)
                            conn.commit()
                        st.success("Saved to database.")
                        st.cache_data.clear()

                if st.button("Reject", key=reject_key):
                    st.info("Rejected — data not saved.")


elif page == "Data Completeness":
    st.title("Data Completeness Report")

    df = load_podcasts()
    if df.empty:
        st.info("No podcasts in database.")
        st.stop()

    st.metric("Total podcasts", len(df))

    completeness = {
        "Email": df["contact_email"].notna().mean() * 100,
        "LinkedIn": df["linkedin_url"].notna().mean() * 100,
        "Instagram/Twitter": df["instagram_url"].notna().mean() * 100,
        "Website": df["website"].notna().mean() * 100,
        "Host Name": df["host_name"].notna().mean() * 100,
    }

    comp_df = pd.DataFrame({"Field": list(completeness.keys()), "% Complete": list(completeness.values())})
    st.bar_chart(comp_df.set_index("Field"))

    st.subheader("Completeness by Category")
    cat_df = df.groupby("category").agg(
        count=("id", "count"),
        pct_email=("contact_email", lambda x: x.notna().mean() * 100),
        pct_linkedin=("linkedin_url", lambda x: x.notna().mean() * 100),
    ).round(1).reset_index()
    st.dataframe(cat_df, use_container_width=True)

    st.subheader("Podcasts with no contact info at all")
    empty = df[
        df["contact_email"].isna() &
        df["linkedin_url"].isna() &
        df["instagram_url"].isna()
    ][["title", "host_name", "category", "total_episodes", "website"]].head(50)
    st.dataframe(empty, use_container_width=True)


elif page == "Outreach Queue":
    st.title("Outreach Queue")

    scored_df = load_scored_leads()
    if scored_df is None:
        st.info("No scored leads found. Run `python scripts/05_score_leads.py` first.")
        st.stop()

    col1, col2, col3 = st.columns(3)
    with col1:
        tier_filter = st.multiselect(
            "Tier", ["hot", "warm", "cold", "skip"],
            default=["hot", "warm"],
        )
    with col2:
        min_episodes = st.slider("Min episodes", 0, 500, 10)
    with col3:
        categories = sorted(scored_df["category"].dropna().unique().tolist())
        cat_filter = st.multiselect("Categories", categories)

    filtered = scored_df[scored_df["lead_tier"].isin(tier_filter)]
    filtered = filtered[filtered["total_episodes"].fillna(0) >= min_episodes]
    if cat_filter:
        filtered = filtered[filtered["category"].isin(cat_filter)]

    st.metric("Showing", len(filtered))

    display_cols = [c for c in [
        "title", "host_name", "category", "total_episodes", "lead_score",
        "lead_tier", "contact_email", "linkedin_url", "score_breakdown"
    ] if c in filtered.columns]
    st.dataframe(filtered[display_cols], use_container_width=True)

    if st.button("Export selection to CSV"):
        csv = filtered.to_csv(index=False)
        st.download_button("Download CSV", csv, "outreach_selection.csv", "text/csv")
