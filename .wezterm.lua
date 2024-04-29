-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()

-- Theme
config.color_scheme = "lovelace"

-- Window Size
config.initial_rows = 40
config.initial_cols = 160

-- Cursor
config.default_cursor_style = "BlinkingBar"

-- Windows
if wezterm.target_triple == "x86_64-pc-windows-msvc" then
	-- Test GPU
	config.webgpu_preferred_adapter = {
		backend = "Vulkan",
		device = 8712,
		device_type = "DiscreteGpu",
		driver = "NVIDIA",
		driver_info = "552.12",
		name = "NVIDIA GeForce RTX 3080 Ti",
		vendor = 4318,
	}
	config.front_end = "WebGpu"
	-- WSL
	config.default_domain = "WSL:Ubuntu"
	config.default_cwd = "/home/erfi"
	config.launch_menu = {
		{
			label = "PowerShell",
			domain = { DomainName = "local" },
			args = { "powershell.exe", "-NoLogo" },
		},
	}
end

-- Keybind for launch_menu
config.keys = {
	{ key = "l", mods = "ALT", action = wezterm.action.ShowLauncher },
}
-- Fonts
config.font = wezterm.font({ family = "IosevkaTerm NF", weight = "Regular" })
config.font_size = 11.5
config.line_height = 1

-- Window Close Prompt
config.window_close_confirmation = "NeverPrompt"

-- and finally, return the configuration to wezterm
return config
