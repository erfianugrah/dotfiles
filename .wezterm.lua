-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()

-- For example, changing the color scheme:
config.color_scheme = "lovelace"

-- Windows
if wezterm.target_triple == "x86_64-pc-windows-msvc" then
	-- WSL
	config.default_domain = "WSL:Ubuntu"
	config.default_cwd = "/home/erfi"
	config.launch_menu = {
		{
			label = "PowerShell",
			args = { "powershell.exe", "-NoLogo" },
		},
	}
end

-- Keybind for launch_menu
config.keys = {
	{ key = "l", mods = "ALT", action = wezterm.action.ShowLauncher },
}
-- Fonts
config.font = wezterm.font("IosevkaTerm NF")
config.font_size = 11
config.line_height = 1

-- and finally, return the configuration to wezterm
return config
