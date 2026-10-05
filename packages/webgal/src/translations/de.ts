const de = {
  // 通用
  common: {
    yes: 'Ja',
    no: 'Nein',
  },

  characterLoading: {
    preparing: 'Figuren werden vorbereitet',
    failed: 'Figuren konnten nicht geladen werden',
    retry: 'Erneut versuchen',
  },

  menu: {
    options: {
      title: 'OPTIONEN',
      pages: {
        system: {
          title: 'System',
          options: {
            meshCloth: {
              experimental: 'Experimentelle Funktionen',
              title: 'Stoffphysik',
              off: 'Aus',
              on: 'Ein',
              description: 'Kann Durchdringungen der Röcke von Hasunosora-Figuren reduzieren, erhöht aber den Rechenaufwand stark und kann leicht zu Rucklern führen.',
              titleOnly: 'Zum Ändern zum Titelbildschirm zurückkehren.',
            },
            characterLoading: {
              title: 'Figuren laden',
              options: {
                scene: 'Szene vorladen (ausgewogen)',
                onDemand: 'Bei Bedarf',
              },
              description: {
                scene: 'Für Videoaufnahmen und normales Spielen geeignet. Figuren werden vor Szenenbeginn vorbereitet. Begrenzen Sie unterschiedliche 3D-Modelle pro Szene, um Videospeicher zu sparen.',
                onDemand: 'Benötigt weniger GPU-Ressourcen. Geeignet bei vielen Figurenarten mit wenigen gleichzeitig genutzten Figuren oder gelegentlich großen Gruppen. Kommende Figuren werden während der Wiedergabe im Hintergrund vorbereitet. Die Ladeanzeige erscheint nur bei noch nicht abgeschlossener Vorbereitung; häufige neue Modelle können die Wartezeit erhöhen.',
              },
            },
            autoSpeed: {
              title: 'Auto-Geschwindigkeit',
              options: {
                slow: 'Langsam',
                medium: 'Normal',
                fast: 'Schnell',
              },
            },
            language: {
              title: 'Sprache',
            },
            resetData: {
              title: 'Daten löschen oder zurücksetzen',
              options: {
                clearGameSave: 'Alle Spielstände löschen',
                resetSettings: 'Alle Einstellungen zurücksetzen',
                clearAll: 'Alle Daten löschen',
              },
              dialogs: {
                clearGameSave: 'Sind Sie sicher, dass Sie den Spielstand löschen möchten?',
                resetSettings: 'Sind Sie sicher, dass Sie alle Einstellungen zurücksetzen möchten?',
                clearAll: 'Sind Sie sicher, dass Sie alle Daten löschen möchten?',
              },
            },
            gameSave: {
              title: 'Spielstand und Optionen importieren oder exportieren',
              options: {
                export: 'Spielstand und Optionen exportieren',
                import: 'Spielstand und Optionen importieren',
              },
              dialogs: {
                import: {
                  title: 'Sind Sie sicher, dass Sie den Spielstand und die Optionen importieren möchten?',
                  tip: 'Spielstand importieren',
                  error: 'Ein Fehler ist beim Analysieren des Spielstands aufgetreten',
                },
              },
            },
            about: {
              title: 'Über WebGAL',
              subTitle: 'WebGAL: Eine Open-Source Web-Based Visual Novel Engine',
              version: 'Version',
              source: 'Source Code Repository',
              contributors: 'Contributors',
              website: 'Website',
            },
            skipAll: {
              title: 'Schnellvorlauf-Modus',
              options: {
                read: 'Gelesen',
                all: 'Alle',
              },
            },
          },
        },
        display: {
          title: 'Darstellung',
          options: {
            enableBangControlPanel: {
              title: 'BanG Dream Stil Menü',
              options: {
                on: 'AN',
                off: 'AUS',
              },
            },
            screenRotation: {
              title: 'Bildschirmausrichtung',
              options: {
                auto: 'Auto',
                angle0: '0°',
                angle90: '90°',
                angle180: '180°',
                angle270: '270°',
              },
            },
            textSpeed: {
              title: 'Geschwindigkeit der Textanzeige',
              options: {
                slow: 'Langsam',
                medium: 'Normal',
                fast: 'Schnell',
              },
            },
            textSize: {
              title: 'Textgröße',
              options: {
                small: 'Klein',
                medium: 'Normal',
                large: 'Groß',
              },
            },
            textFont: {
              title: 'Schriftart',
              options: {
                resourceHanRounded: 'Resource Han Rounded',
                siYuanSimSun: 'Source Han Serif',
                SimHei: 'Sans',
              },
            },
            textboxOpacity: {
              title: 'Textbox Opacity',
            },
            textPreview: {
              title: 'Vorschautext wird angezeigt',
              text: 'Sie können jederzeit die Schriftart, Größe und Wiedergabegeschwindigkeit des Textes nach Ihrer Vorliebe anpassen.',
            },
          },
        },
        sound: {
          title: 'Ton',
          options: {
            volumeMain: { title: 'Hauptlautstärke' },
            vocalVolume: { title: 'Stimmlautstärke' },
            bgmVolume: { title: 'Musiklautstärke' },
            seVolume: { title: 'Soundeffektlautstärke' },
            uiSeVolume: { title: 'UI Soundeffektlautstärke' },
          },
        },
        // language: {
        //   title: 'Sprache',
        //   options: {
        //   },
        // },
      },
    },
    saving: {
      title: 'SPEICHERN',
      isOverwrite: 'Sind Sie sicher, dass Sie diesen Spielstand überschreiben möchten?',
    },
    loadSaving: {
      title: 'LADEN',
    },
    flowchart: {
      title: 'ABLAUF',
    },
    title: {
      title: 'TITEL',
    },
    exit: {
      title: 'ZURÜCK',
    },
  },

  title: {
    start: {
      title: 'STARTEN',
      subtitle: '',
    },
    continue: {
      title: 'WEITERLESEN',
      subtitle: '',
    },
    options: {
      title: 'OPTIONEN',
      subtitle: '',
    },
    load: {
      title: 'LADEN',
      subtitle: '',
    },
    extra: {
      title: 'EXTRA',
      subtitle: '',
    },
    exit: {
      title: 'BEENDEN',
      subtitle: '',
      tips: 'Sind Sie sicher, dass Sie das Spiel beenden möchten?',
    },
  },

  gaming: {
    noSaving: 'Keine Speicherung',
    buttons: {
      hide: 'Verstecken',
      show: 'Anzeigen',
      backlog: 'Verlauf',
      flowchart: 'Ablauf',
      replay: 'Wiedergabe',
      auto: 'Auto',
      forward: 'Überspringen',
      quicklySave: 'Quickly Save',
      quicklyLoad: 'Quickly Load',
      save: 'Speichern',
      load: 'Laden',
      fullscrreen: 'Vollbild',
      options: 'Optionen',
      title: 'Titel',
    },
    flowchart: {
      title: 'Ablauf',
      empty: 'Kein Ablauf',
      locked: 'Gesperrt',
      main: 'Haupt',
      character: 'Route',
      root: 'Start',
      chapter: 'Kapitel',
    },
  },

  extra: {
    title: 'EXTRA',
  },
};

export default de;
