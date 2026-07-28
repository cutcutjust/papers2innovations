from __future__ import annotations

from p2i_engine.parsing.parser import _semantic_sections


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
