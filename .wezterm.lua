-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()

-- This is where you actually apply your config choices

-- For example, changing the color scheme:
config.color_scheme = "lovelace"

-- WSL
-- config.default_domain = "WSL:Ubuntu"

-- Fonts
config.font = wezterm.font("MesloLGS Nerd Font Mono")
config.font_size = 10
config.line_height = 1

-- Paste

-- Working directory
config.default_cwd = "/home/deck"

-- and finally, return the configuration to wezterm
return config
