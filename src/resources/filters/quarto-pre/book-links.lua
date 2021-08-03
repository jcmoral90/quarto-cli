-- book-links.lua
-- Copyright (C) 2020 by RStudio, PBC

local path = require 'pandoc.path'

function indexBookFileTargets() 
    return {
      Header = function(el)
      local file = currentFileMetadataState().file
      if file ~= nil and (param("single-file-book", false)) then
        if el.level == 1 then 
          local filename = file.bookItemFile;
          if filename ~= nil and preState.fileSectionIds[filename] == nil then
            preState.fileSectionIds[filename] = el.identifier
          end
        end
      end
    end
  }
end

function resolveBookFileTargets() 
  return {
    Link = function(el)
      local linkTarget = el.target
      -- if this is a local path
      if isRelativeRef(linkTarget) then
        local file = currentFileMetadataState().file

        -- normalize the linkTarget (collapsing any '..')
        if linkTarget ~= nil then
          local fullPath = linkTarget
          if file ~= nil and file.resourceDir ~= nil then
            fullPath = path.join({file.resourceDir, linkTarget})
          end
          linkTarget = path.normalize(flatten(fullPath));
        end
        
        -- resolve the path
        local hashPos = string.find(linkTarget, '#')
        if hashPos ~= nil then
          -- deal with a link that includes a hash (just remove the prefix)
          local target = string.sub(linkTarget, hashPos, #linkTarget)
          el.target = target
        else
          -- Deal with bare file links
          local sectionId = preState.fileSectionIds[linkTarget];
          if sectionId ~= nil then
            el.target = '#' .. sectionId
          end
        end
      end
      return el
    end
    
  }
end

function flatten(targetPath) 
  local pathParts = path.split(targetPath)
  local resolvedPath = pandoc.List:new()

  for _, part in ipairs(pathParts) do 
    if part == '..' then
      table.remove(resolvedPath)
    else
      resolvedPath:insert(part)
    end
  end
  return path.join(resolvedPath)
end