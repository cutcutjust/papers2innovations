from __future__ import annotations

from pathlib import Path

import fitz

from p2i_engine.parsing.parser import (
    _embed_figures,
    _extract_rendered_figures,
    _markdown_quality_issues,
    _normalize_extracted_text,
    _normalize_reference_layout,
    _semantic_sections,
)


def test_semantic_sections_merge_content_across_pages() -> None:
    sections = _semantic_sections(
        [
            (1, "PAPER RUNNING HEADER\n\nAbstract\n\nSummary text."),
            (2, "PAPER RUNNING HEADER\n\n1 Introduction\n\nOpening argument."),
            (3, "Introduction continues.\n\n2.1 Experimental Setup\n\nSetup details."),
        ],
        "paper-1",
    )

    assert [section.title for section in sections] == [
        "Abstract",
        "1 Introduction",
        "2.1 Experimental Setup",
    ]
    assert sections[1].page_start == 2
    assert sections[1].page_end == 3
    assert sections[2].level == 2
    assert [anchor.page for anchor in sections[1].anchors] == [2, 3]
    assert all(anchor.section_id == sections[1].id for anchor in sections[1].anchors)


def test_semantic_sections_use_markdown_headings_from_ocr() -> None:
    sections = _semantic_sections(
        [(1, "## Introduction\n\nText."), (2, "### Method\n\nDetails.")],
        "paper-2",
    )

    assert [(section.title, section.level) for section in sections] == [
        ("Introduction", 2),
        ("Method", 3),
    ]


def test_semantic_sections_fall_back_to_one_document() -> None:
    sections = _semantic_sections(
        [(1, "First page without headings."), (2, "Second page without headings.")],
        "paper-3",
    )

    assert len(sections) == 1
    assert sections[0].title == "Document"
    assert sections[0].page_start == 1
    assert sections[0].page_end == 2
    assert [anchor.page for anchor in sections[0].anchors] == [1, 2]


def test_normalize_extracted_text_repairs_pdf_control_glyphs_and_wraps() -> None:
    normalized = _normalize_extracted_text(
        "Linear\n\x00\nGELU\n\x01\nbi-\nases and cross-\nmodal features"
    )

    assert "\x00" not in normalized
    assert "\x01" not in normalized
    assert "(\nGELU\n)" in normalized
    assert "biases" in normalized
    assert "cross-modal" in normalized


def test_fallback_parser_renders_vector_figure_and_embeds_markdown(tmp_path: Path) -> None:
    source = tmp_path / "vector-figure.pdf"
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.draw_rect(fitz.Rect(72, 72, 540, 190), color=(0, 0, 0), width=1)
    page.draw_line((100, 150), (500, 100), color=(0.2, 0.4, 0.8), width=3)
    page.insert_text((90, 110), "Vector architecture", fontsize=16)
    page.insert_text((72, 220), "Fig. 1: Synthetic vector architecture.", fontsize=11)
    document.save(source)
    document.close()

    figure_dir = tmp_path / "figures"
    figure_dir.mkdir()
    figures = _extract_rendered_figures(source, figure_dir)

    assert len(figures) == 1
    assert figures[0].caption == "Fig. 1: Synthetic vector architecture."
    assert (tmp_path / figures[0].relative_path).is_file()
    markdown = _embed_figures(
        "Intro text.\n\nFig. 1: Synthetic vector architecture.\n\nMethod text.",
        figures,
    )
    assert markdown.index("![Figure 1: Synthetic vector architecture.]") < markdown.index(
        "\n\nFig. 1: Synthetic vector architecture."
    )


def test_reference_layout_only_splits_bibliography_entries() -> None:
    markdown = (
        "Body cites [1] and [2] together.\n\n"
        "# References\n\n[1] First paper. [2] Second paper.\n[3] Third paper."
    )

    normalized = _normalize_reference_layout(markdown)

    assert "Body cites [1] and [2] together." in normalized
    assert "[1] First paper.\n\n[2] Second paper.\n\n[3] Third paper." in normalized


def test_markdown_quality_gate_detects_flattened_tables_and_bare_formulas() -> None:
    markdown = (
        "Table 2. Ablation results\n"
        "Dataset Model A B C ours 71.05 87.60 70.88 baseline 69.61 85.43 69.18\n\n"
        "The objective is {stage1 = task1 + lcons}."
    )

    kinds = {issue["kind"] for issue in _markdown_quality_issues(markdown)}

    assert kinds == {"formula", "table"}
