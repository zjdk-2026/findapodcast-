import os
from datetime import datetime
from sqlalchemy import text, inspect
from loguru import logger
from rich.console import Console
from rich.table import Table
from .connect import get_engine

console = Console()


def inspect_schema() -> dict:
    engine = get_engine()
    inspector = inspect(engine)
    result = {}

    table_names = inspector.get_table_names(schema="public")

    with engine.connect() as conn:
        for table in table_names:
            columns = inspector.get_columns(table, schema="public")
            row_count = conn.execute(text(f'SELECT COUNT(*) FROM public."{table}"')).scalar()
            try:
                sample = conn.execute(
                    text(f'SELECT * FROM public."{table}" LIMIT 5')
                ).mappings().all()
                sample = [dict(r) for r in sample]
            except Exception:
                sample = []

            result[table] = {
                "columns": columns,
                "row_count": row_count,
                "sample": sample,
            }

    return result


def print_schema(schema: dict):
    console.print("\n[bold cyan]Database Schema Inspector[/bold cyan]\n")

    summary = Table("Table", "Rows", "Columns", title="Tables Overview")
    for table, info in schema.items():
        summary.add_row(table, str(info["row_count"]), str(len(info["columns"])))
    console.print(summary)

    for table, info in schema.items():
        console.print(f"\n[bold yellow]{table}[/bold yellow] ({info['row_count']} rows)")
        col_table = Table("Column", "Type", "Nullable", show_lines=False)
        for col in info["columns"]:
            col_table.add_row(
                col["name"],
                str(col["type"]),
                "YES" if col.get("nullable", True) else "NO",
            )
        console.print(col_table)


def generate_markdown_report(schema: dict, output_path: str):
    lines = [
        "# Database Schema Report",
        f"\nGenerated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n",
    ]

    lines.append("## Tables Overview\n")
    lines.append("| Table | Rows | Columns |")
    lines.append("|-------|------|---------|")
    for table, info in schema.items():
        lines.append(f"| {table} | {info['row_count']} | {len(info['columns'])} |")

    for table, info in schema.items():
        lines.append(f"\n## `{table}` ({info['row_count']} rows)\n")
        lines.append("| Column | Type | Nullable |")
        lines.append("|--------|------|----------|")
        for col in info["columns"]:
            lines.append(f"| {col['name']} | {col['type']} | {'YES' if col.get('nullable', True) else 'NO'} |")

        if info["sample"]:
            lines.append("\n### Sample Rows\n")
            cols = list(info["sample"][0].keys())
            lines.append("| " + " | ".join(cols) + " |")
            lines.append("|" + "---|" * len(cols))
            for row in info["sample"]:
                cells = [str(v)[:60].replace("|", "\\|") if v is not None else "NULL" for v in row.values()]
                lines.append("| " + " | ".join(cells) + " |")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        f.write("\n".join(lines))
    logger.success(f"Schema report saved to {output_path}")
