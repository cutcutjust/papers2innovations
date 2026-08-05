from p2i_engine.parsing.visual_regions import _render_blocks


def test_render_blocks_writes_numbered_formulas_as_display_math() -> None:
    markdown, confidence = _render_blocks(
        {
            "blocks": [
                {
                    "type": "formula",
                    "number": 5,
                    "text": r"\beta = 1 - \frac{d(z_i, c_i)}{\max_k d(z_k, c_k)}",
                    "confidence": 0.98,
                }
            ]
        }
    )

    assert markdown.startswith("$$\n")
    assert markdown.endswith("\n$$")
    assert r"\tag{5}" in markdown
    assert confidence == 0.98
