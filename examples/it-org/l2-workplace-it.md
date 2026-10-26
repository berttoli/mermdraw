# L2 · Workplace IT

Drill-down of **Workplace IT** from the [L1 landscape](README.md): identity, collaboration SaaS,
managed devices, and the self-hosted lab. Mixes the `logos` and `devicon` packs.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#FFF4E6"
    primaryBorderColor: "#E8590C"
    primaryTextColor: "#4A1D05"
    lineColor: "#C9967A"
    clusterBkg: "#FFF9F2"
    clusterBorder: "#F2C9A5"
    edgeLabelBackground: "#FFFFFF"
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
---
flowchart TD
    people([Employees & contractors])
    idp@{ icon: "logos:okta-icon", label: "Okta · SSO + MFA", pos: "b", h: 48 }
    subgraph devices [Managed devices]
        direction LR
        mac@{ icon: "logos:apple", label: "macOS · Jamf", pos: "b", h: 36 }
        win@{ icon: "logos:microsoft-windows-icon", label: "Windows · Intune", pos: "b", h: 36 }
        linux@{ icon: "logos:linux-tux", label: "Linux workstations", pos: "b", h: 36 }
    end
    subgraph saas [Collaboration SaaS]
        direction LR
        workspace@{ icon: "logos:google-icon", label: "Google Workspace", pos: "b", h: 36 }
        slack@{ icon: "logos:slack-icon", label: "Slack", pos: "b", h: 36 }
        zoom@{ icon: "logos:zoom-icon", label: "Zoom", pos: "b", h: 36 }
        jira@{ icon: "logos:jira", label: "Jira", pos: "b", h: 36 }
        confluence@{ icon: "logos:confluence", label: "Confluence", pos: "b", h: 36 }
        github@{ icon: "logos:github-icon", label: "GitHub Enterprise", pos: "b", h: 36 }
    end
    subgraph lab [Self-hosted lab · on-prem]
        direction LR
        proxmox@{ icon: "devicon:proxmox", label: "Proxmox cluster", pos: "b", h: 36 }
        gitea@{ icon: "devicon:gitea", label: "Gitea mirror", pos: "b", h: 36 }
        loki@{ icon: "devicon:grafanaloki", label: "Loki · lab logs", pos: "b", h: 36 }
    end
    serviceDesk[Service desk · Jira Service Management]
    people --> devices
    people -->|SSO| idp
    idp -->|SAML / OIDC| saas
    idp -.->|SCIM provisioning| saas
    devices -.->|device trust| idp
    idp --> lab
    people -.->|tickets| serviceDesk
    serviceDesk --> jira
    style lab fill:#F8FAFC,stroke:#CBD5E1,stroke-dasharray:5 4
```
