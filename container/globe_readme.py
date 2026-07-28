"""Casual README bundled in globe stripe zips."""

import math


def globe_stripe_length_cm(diameter_cm: float) -> float:
    """Pole-to-pole strip length (half the globe circumference)."""
    return math.pi * diameter_cm / 2


def stripe_height_px(diameter_cm: float) -> int:
    """Stripe JPEG height at 160 px/cm."""
    return round(globe_stripe_length_cm(diameter_cm) * 160)


def diameter_cm_from_stripe_height_px(stripe_height_px: int) -> float:
    """Recover globe diameter from pole-to-pole stripe height."""
    return (stripe_height_px / 160.0) * 2.0 / math.pi


def globe_readme_text(*, stripe_count: int, diameter_cm: float, uploaded: bool) -> str:
    diameter = (
        f"{int(diameter_cm)} cm"
        if abs(diameter_cm - round(diameter_cm)) < 0.05
        else f"{diameter_cm:.1f} cm"
    )
    stripe_len = (
        f"{globe_stripe_length_cm(diameter_cm):.1f} cm"
        if abs(diameter_cm - round(diameter_cm)) >= 0.05
        else f"{globe_stripe_length_cm(diameter_cm):.0f} cm"
    )
    map_file = "input.jpg (your uploaded map)" if uploaded else "input.svg (square map from OpenStreetMap)"

    return f"""Globus Maker — globe stripes
================================

Thanks for making a globe! Here is what is in this zip and how to use it.

What's inside
-------------
• {map_file}
• pole-caps.jpg — two circles for the top and bottom of the globe
• out-00.jpg … out-{max(0, stripe_count - 1):02d}.jpg — {stripe_count} long strips that wrap around the middle (about {stripe_len} pole to pole each)

These files are sized for a {diameter} globe. Print at 100% scale — do not shrink or stretch in your print dialog.

How to assemble (short version)
-------------------------------
1. Print every JPEG. Use good paper or thin card if you can.
2. Cut out the pole caps along the yellow circle. The tiny yellow dot is the centre.
3. Cut out each stripe. The wavy yellow line shows where the edge should meet the next strip — line those curves up when you glue.
4. Glue the strips around a ball or balloon, working from the middle toward the poles.
5. Finish with the north cap (your map centre) and south cap (plain fill colour).

Tips
----
• Take your time lining up the yellow cut lines — that is what keeps the map from drifting.
• You can keep input.svg as a backup or edit it in vector software before printing.
• Made with Globus Maker.

Happy gluing!

"""
