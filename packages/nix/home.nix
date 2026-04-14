{ config, pkgs, ... }:

{
  home.username = "deck";
  home.homeDirectory = "/home/deck";
  home.stateVersion = "24.05";

  programs.home-manager.enable = true;

  nixpkgs.config.allowUnfree = true;

  # ---------------------------------------------------------------------------
  # Packages — mirrors core tools from Arch/brew lists
  # Update by editing this list, then: home-manager switch --flake .#deck
  # ---------------------------------------------------------------------------
  home.packages = with pkgs; [
    # Shell & terminal
    zsh
    tmux
    fzf
    bat
    eza
    fd
    ripgrep
    zoxide
    btop
    jq

    # Editors
    neovim
    vim

    # Git
    git
    delta
    gh

    # Network
    wget
    httpie
    mtr
    cloudflared

    # Cloud & IaC
    opentofu
    terraform
    sops
    age
    ansible
    awscli2
    kubectl
    k9s
    kubelogin
    flyctl

    # Security & supply chain
    cosign
    syft
    trivy

    # DevOps tools
    caddy
    xcaddy
    d2
    goreleaser
    k6
    vegeta

    # Languages & runtimes
    go
    lua
    nodejs
    pnpm
    yarn

    # Utilities
    stow
    rclone
    unzip
    zip
    rsync
    ffmpeg
  ];

  # Make nix apps visible in Steam Deck Game Mode menus
  targets.genericLinux.enable = true;
}
