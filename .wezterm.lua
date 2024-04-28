-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()
-- This is where you actually apply your config choices
-- For example, changing the color scheme:
config.color_scheme = "lovelace"

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
config.font_size = 11
config.line_height = 1.2

-- and finally, return the configuration to wezterm
return config
