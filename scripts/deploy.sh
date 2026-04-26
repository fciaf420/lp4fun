#!/usr/bin/env bash
#
# Build + deploy dlmm-private-wrap.
#
# Usage:
#   scripts/deploy.sh init                    # generate program-id keypair (run once)
#   scripts/deploy.sh build                   # anchor build
#   scripts/deploy.sh deploy <devnet|mainnet> # deploy the .so
#
# After `init`, paste the printed program id into:
#   - programs/dlmm-private-wrap/src/lib.rs  (declare_id!(...))
#   - Anchor.toml                             ([programs.*])
#   - app/utils/privateWrap.ts                (PRIVATE_WRAP_PROGRAM_ID)
# then run `build`, then `deploy`.
#
# The script does not call solana-keygen / solana / anchor for you — they're
# the actions that touch your keys, so you should see them in your shell
# history. This is just orchestration.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROGRAM_NAME="dlmm_private_wrap"
KEYPAIR_PATH="target/deploy/${PROGRAM_NAME}-keypair.json"
SO_PATH="target/deploy/${PROGRAM_NAME}.so"

cmd="${1:-}"

case "$cmd" in
    init)
        if [[ -f "$KEYPAIR_PATH" ]]; then
            echo "Keypair already exists at $KEYPAIR_PATH"
            echo "Program id: $(solana-keygen pubkey "$KEYPAIR_PATH")"
            exit 0
        fi
        mkdir -p "$(dirname "$KEYPAIR_PATH")"
        solana-keygen new --no-bip39-passphrase --outfile "$KEYPAIR_PATH"
        echo
        echo "Program id: $(solana-keygen pubkey "$KEYPAIR_PATH")"
        echo "Paste this id into:"
        echo "  - programs/dlmm-private-wrap/src/lib.rs  (declare_id!)"
        echo "  - Anchor.toml                             ([programs.*])"
        echo "  - app/utils/privateWrap.ts                (PRIVATE_WRAP_PROGRAM_ID)"
        ;;

    build)
        if [[ ! -f "$KEYPAIR_PATH" ]]; then
            echo "Run '$0 init' first to generate a program id keypair."
            exit 1
        fi
        anchor build
        echo
        echo "Built: $SO_PATH"
        echo "Program id (must match declare_id!): $(solana-keygen pubkey "$KEYPAIR_PATH")"
        ;;

    deploy)
        network="${2:-}"
        case "$network" in
            devnet)  url="https://api.devnet.solana.com" ;;
            mainnet) url="https://api.mainnet-beta.solana.com" ;;
            *) echo "Usage: $0 deploy <devnet|mainnet>"; exit 1 ;;
        esac

        if [[ ! -f "$SO_PATH" ]]; then
            echo "$SO_PATH not found. Run '$0 build' first."
            exit 1
        fi

        program_id="$(solana-keygen pubkey "$KEYPAIR_PATH")"
        echo "Network:    $network ($url)"
        echo "Program id: $program_id"
        echo "Binary:     $SO_PATH ($(du -h "$SO_PATH" | cut -f1))"
        echo

        if [[ "$network" == "mainnet" ]]; then
            cat <<'EOF'
========================================================================
  About to deploy a custodial wrapper program to MAINNET.

  This program signs CPIs as PDA owners of users' DLMM positions. A bug
  or a malicious upgrade can drain every user's funds.

  Before proceeding, confirm:
    [ ] The program has been tested on devnet end-to-end (init, add,
        remove, claim, close).
    [ ] The upgrade authority will be transferred to a Squads multisig
        immediately after deploy.
    [ ] You accept the risk of running unaudited custodial code.

========================================================================
EOF
            read -r -p 'Type DEPLOY MAINNET to continue: ' confirm
            if [[ "$confirm" != "DEPLOY MAINNET" ]]; then
                echo "Aborted."
                exit 1
            fi
        fi

        solana program deploy \
            --url "$url" \
            --program-id "$KEYPAIR_PATH" \
            "$SO_PATH"

        echo
        echo "Deployed to $network."
        if [[ "$network" == "mainnet" ]]; then
            echo
            echo "IMMEDIATE NEXT STEP: transfer upgrade authority to a multisig:"
            echo "  solana program set-upgrade-authority \\"
            echo "    --url $url \\"
            echo "    $program_id \\"
            echo "    --new-upgrade-authority <SQUADS_VAULT_PUBKEY>"
        fi
        ;;

    *)
        echo "Usage: $0 {init|build|deploy <devnet|mainnet>}"
        exit 1
        ;;
esac
