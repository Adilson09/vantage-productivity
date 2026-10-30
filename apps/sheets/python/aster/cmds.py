"""Small convenience facade. Mutations always use the caller's transaction."""

from typing import Any
from .sheet import EngineSession, Transaction, Workbook


def open_workbook(engine: EngineSession, path: str, **options: Any) -> Workbook:
    return engine.open_workbook(path, **options)


def set_values(transaction: Transaction, sheet: Any, area: Any, values: Any) -> Any:
    return transaction.range(sheet, area).set_values(values)


def set_formula(transaction: Transaction, sheet: Any, area: Any, formula: str) -> Any:
    return transaction.range(sheet, area).set_formula(formula)


def set_style(transaction: Transaction, sheet: Any, area: Any, style: Any) -> Any:
    return transaction.range(sheet, area).set_style(style)


def clear(transaction: Transaction, sheet: Any, area: Any, **options: Any) -> Any:
    return transaction.range(sheet, area).clear(**options)


def read(workbook: Workbook, sheet: Any, area: Any) -> Any:
    return workbook.read(sheet, area)


def calculate_and_wait(workbook: Workbook, reads: Any = (), **options: Any) -> Any:
    return workbook.calculate_and_wait(reads, **options)
