# ============================================================================
# amali_theme.R
# ggplot2 theme + color palette matching AMALI branding
# Source: colors/fonts extracted from 260722Presentation to LCC.pptx
# ============================================================================

library(tidyverse)
library(sysfonts)
library(showtext)

# --- Fonts ------------------------------------------------------------------
# Raleway = AMALI's heading/display font. Falls back gracefully if the Google
# Fonts lookup fails offline (theme still works, just uses default sans).
tryCatch({
  font_add_google("Raleway", "raleway")
  showtext_auto()
}, error = function(e) {
  message("Could not load Raleway from Google Fonts; using system sans instead.")
})

# --- Color palette ------------------------------------------------------------
amali_colors <- c(
  green_primary   = "#14472E",
  green_secondary = "#196B24",
  gold_primary    = "#E8A838",
  gold_logo       = "#F0AB00",
  gold_bright     = "#FFC000",
  teal            = "#00685B",
  navy            = "#192C59",
  navy_light      = "#2A3D5C",
  cream           = "#F8EDCA",
  mint_bg         = "#EAF2EA",
  slate_bg        = "#C8D3E0",
  black           = "#000000",
  white           = "#FFFFFF"
)

#' Retrieve one or more AMALI brand colors by name
#' @param ... names of colors in `amali_colors`; if none given, returns all
amali_pal <- function(...) {
  cols <- c(...)
  if (length(cols) == 0) return(amali_colors)
  amali_colors[cols]
}

# Ordered qualitative palette for multi-series charts
amali_qual_palette <- unname(amali_colors[c(
  "green_primary", "gold_primary", "teal", "navy", "gold_bright", "green_secondary"
)])

# Sequential palette (light -> dark green), handy for choropleths / heatmaps
amali_seq_palette <- c("#EAF2EA", "#B8D4C0", "#6FA07E", "#316B41", "#14472E")

# --- Scales -------------------------------------------------------------------
scale_color_amali <- function(...) {
  ggplot2::discrete_scale("colour", "amali", scales::manual_pal(amali_qual_palette), ...)
}

scale_fill_amali <- function(...) {
  ggplot2::discrete_scale("fill", "amali", scales::manual_pal(amali_qual_palette), ...)
}

scale_fill_amali_seq <- function(...) {
  ggplot2::scale_fill_gradientn(colors = amali_seq_palette, ...)
}

# --- Theme ----------------------------------------------------------------
theme_amali <- function(base_size = 12, base_family = "sans") {
  raleway <- if ("raleway" %in% sysfonts::font_families()) "raleway" else base_family

  theme_minimal(base_size = base_size, base_family = base_family) %+replace%
    theme(
      text          = element_text(color = amali_colors[["black"]]),
      plot.title    = element_text(family = raleway, face = "bold", size = rel(1.4),
                                    color = amali_colors[["black"]], hjust = 0,
                                    margin = margin(b = 8)),
      plot.subtitle = element_text(color = amali_colors[["navy"]], hjust = 0,
                                    margin = margin(b = 10)),
      plot.caption  = element_text(color = amali_colors[["navy_light"]], size = rel(0.75),
                                    hjust = 1),
      axis.title    = element_text(family = raleway, face = "bold", size = rel(0.95)),
      axis.text     = element_text(color = amali_colors[["black"]]),
      panel.grid.minor = element_blank(),
      panel.grid.major = element_line(color = amali_colors[["slate_bg"]], linewidth = 0.3),
      legend.title  = element_text(family = raleway, face = "bold"),
      legend.position = "bottom",
      strip.background = element_rect(fill = amali_colors[["mint_bg"]], color = NA),
      strip.text    = element_text(family = raleway, face = "bold",
                                    color = amali_colors[["green_primary"]])
    )
}

# ============================================================================
# Example usage:
#
# source("amali_theme.R")
#
# ggplot(mpg, aes(class, fill = class)) +
#   geom_bar() +
#   scale_fill_amali() +
#   theme_amali() +
#   labs(title = "Example AMALI-styled chart", x = NULL, y = "Count")
# ============================================================================
